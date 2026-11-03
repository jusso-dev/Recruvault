#!/usr/bin/env bash
# Production Compose install proof.
#
#   scripts/compose-proof.sh --context <docker-context> [--project <name>]
#
# Builds the images on the named Docker context, starts the production stack
# (docker-compose.yml + docker-compose.prod.yml) with the test-only overlay in
# test/compose/docker-compose.proof.yml, and walks fresh install -> verified
# owner -> customer-key enrolment -> restart -> failure scenarios. Every secret
# is generated here into a 0600 file in a private temp directory, never
# printed, and deleted on exit. The project's containers, volumes, network, and
# built images are removed on exit.
#
# Output is check names and pass/fail only. Optional environment:
#   PROOF_APP_PORT (default 3130)  host port, bound to 127.0.0.1 only
#   PROOF_SUBNET   (default 10.200.15.0/24)
set -euo pipefail

CTX=""
PROJECT="rv-proof-$(openssl rand -hex 4)"
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) echo "usage: $0 --context <docker-context> [--project <name>]" >&2; exit 2 ;;
  esac
done
# Always name the Docker context: the default one is not always local.
[ -n "$CTX" ] || { echo "usage: $0 --context <docker-context> [--project <name>]" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PROOF_APP_PORT:-3130}"
HOST="rv-proof.test"
TMP="$(mktemp -d)"
chmod 700 "$TMP"
ENV_FILE="$TMP/proof.env"
LOG="$TMP/compose.log"
FAILED=0

umask 077
hex() { openssl rand -hex "$1"; }
pg_user="rv_$(hex 4)"
pg_password="$(hex 24)"
cat >"$ENV_FILE" <<EOF
POSTGRES_USER=$pg_user
POSTGRES_PASSWORD=$pg_password
POSTGRES_DB=recruvault
DATABASE_URL=postgres://$pg_user:$pg_password@db:5432/recruvault
APP_URL=https://$HOST
TRUSTED_DOMAINS=$HOST
BETTER_AUTH_SECRET=$(hex 32)
LOCAL_KEK=$(hex 32)
BOOTSTRAP_TOKEN=$(hex 32)
MINIO_ROOT_USER=rvadmin$(hex 4)
MINIO_ROOT_PASSWORD=$(hex 24)
AWS_ACCESS_KEY_ID=rvapp$(hex 6)
AWS_SECRET_ACCESS_KEY=$(hex 24)
S3_BUCKET=recruvault-documents
INNGEST_EVENT_KEY=$(hex 32)
INNGEST_SIGNING_KEY=$(hex 32)
RESEND_API_KEY=re_$(hex 24)
RESEND_FROM_EMAIL=no-reply@$HOST
PROOF_OWNER_EMAIL=owner-$(hex 4)@example.org
PROOF_OWNER_PASSWORD=$(hex 18)
PROOF_HOST=$HOST
PROOF_APP_PORT=$PORT
PROOF_SUBNET=${PROOF_SUBNET:-10.200.15.0/24}
EOF
unset pg_user pg_password

dc_with() {
  local env_file="$1"; shift
  docker --context "$CTX" compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$env_file" \
    -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml" \
    -f "$ROOT/test/compose/docker-compose.proof.yml" "$@"
}
dc() { dc_with "$ENV_FILE" "$@"; }
dk() { docker --context "$CTX" "$@"; }

# Production Compose without the proof overlay, on top of base file $2.
prod_config() {
  local env_file="$1" base="$2"
  docker --context "$CTX" compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$env_file" \
    -f "$base" -f "$ROOT/docker-compose.prod.yml" config -q
}
# The base file's services with nothing set, so only docker-compose.prod.yml
# can require a variable when layered on it.
STUB_BASE="$TMP/stub-base.yml"
cat >"$STUB_BASE" <<'EOF'
services:
  app: {image: stub}
  migrate: {image: stub}
  db: {image: stub}
  clamav: {image: stub}
  minio: {image: stub}
  minio-init: {image: stub}
  inngest: {image: stub}
EOF

# Generated credentials and identities to strip from diagnostics.
REDACT="$TMP/redact"
grep -E '^(DATABASE_URL|[A-Z_]*(PASSWORD|SECRET|KEY|KEK|TOKEN|USER|EMAIL|_ID))=' "$ENV_FILE" | cut -d= -f2- >"$REDACT"
redact() {
  local value
  local -a expr=()
  while IFS= read -r value; do
    expr+=(-e "s/$(printf '%s' "$value" | sed 's/[]\/$*.^[]/\\&/g')/[redacted]/g")
  done <"$REDACT"
  # Anything else that looks like a key or token (hex or base64url).
  sed "${expr[@]}" -e 's/[0-9a-fA-F]\{24,\}/[redacted]/g' -e 's/[0-9A-Za-z_-]\{32,\}/[redacted]/g'
}

check() {
  local name="$1"; shift
  if "$@" >>"$LOG" 2>&1; then echo "ok   $name"; else echo "FAIL $name"; FAILED=$((FAILED + 1)); fi
}

teardown() {
  dc --profile proof down -v --rmi local --remove-orphans >>"$LOG" 2>&1 || true
  local left
  left="$(
    dk ps -aq --filter "label=com.docker.compose.project=$PROJECT"
    dk volume ls -q --filter "label=com.docker.compose.project=$PROJECT"
    dk network ls -q --filter "label=com.docker.compose.project=$PROJECT"
    dk images -q --filter "label=com.docker.compose.project=$PROJECT"
  )"
  if [ -z "$left" ]; then echo "ok   project containers, volumes, network, and built images removed"
  else echo "FAIL project containers, volumes, network, and built images removed"; FAILED=$((FAILED + 1)); fi
}

finish() {
  local code=$?
  if [ "$FAILED" -gt 0 ] || [ "$code" -ne 0 ]; then
    dc ps -a --format '  {{.Service}}: {{.State}} {{.Health}} exit={{.ExitCode}}' 2>/dev/null || true
    # Recent lines only, with every generated value and token-like string removed.
    echo "  -- proof log, last 25 lines"
    tail -n 25 "$LOG" 2>/dev/null | redact | sed 's/^/  | /' || true
    echo "  -- migrate and app logs, last 15 lines each"
    dc logs --no-color --tail 15 migrate app 2>/dev/null | redact | sed 's/^/  | /' || true
  fi
  teardown
  rm -rf "$TMP"
  if [ "$FAILED" -gt 0 ] || [ "$code" -ne 0 ]; then echo "Compose proof failed ($FAILED check(s))."; exit 1; fi
  echo "Compose proof passed."
}
trap finish EXIT
# Signals exit through finish too, so an interrupted run still tears down.
trap 'exit 130' INT TERM HUP

# -- helpers run inside the stack -------------------------------------------

# Runs inside the db container, where POSTGRES_USER and POSTGRES_DB are set.
# shellcheck disable=SC2016
psql_q() {
  dc exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh "$1"
}

# Prints "<http code> <status> <database> <storage> <scanner> <jobs>".
health() {
  dc exec -T app node -e "fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(10000) }).then(async r => { const j = await r.json(); console.log(r.status, j.status, j.database, j.storage, j.scanner, j.jobs) }).catch(() => console.log('error'))"
}
health_is() { [ "$(health)" = "$1" ]; }

http_code() {
  dc exec -T app node -e "fetch('http://127.0.0.1:3000$1', { method: '${2:-GET}', signal: AbortSignal.timeout(10000) }).then(r => console.log(r.status)).catch(() => console.log('error'))"
}

wait_until() {
  local seconds="$1"; shift
  local deadline=$((SECONDS + seconds))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 3
  done
}

live_ok() { [ "$(http_code /api/live)" = 200 ]; }
readiness_unavailable() { health | grep -q '^503 unavailable unavailable '; }
restart_app() { dc restart app && wait_until 120 app_healthy; }
app_healthy() { [ "$(dk inspect -f '{{.State.Health.Status}}' "$(dc ps -q app)")" = "healthy" ]; }
driver() { dc run --rm --no-deps proof-driver "$@" 2>>"$LOG"; }

# Without $1 (in the env file and this shell), production Compose must refuse
# to render and name $1: as shipped, and with docker-compose.prod.yml alone on
# the stub base, because the shipped base file already requires some secrets.
missing_secret_refused() {
  local name="$1" partial="$TMP/missing.env" base out
  grep -v "^$name=" "$ENV_FILE" >"$partial"
  for base in "$ROOT/docker-compose.yml" "$STUB_BASE"; do
    if out="$(unset "$name"; prod_config "$partial" "$base" 2>&1)"; then return 1; fi
    printf '%s\n' "$out"
    printf '%s\n' "$out" | grep -q "required variable $name is missing a value" || return 1
  done
}
prod_renders() { prod_config "$ENV_FILE" "$ROOT/docker-compose.yml" && prod_config "$ENV_FILE" "$STUB_BASE"; }

only_app_published() {
  local published
  published="$(dk ps --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -- '->' || true)"
  [ "$(printf '%s\n' "$published" | grep -c .)" -eq 1 ] &&
    printf '%s' "$published" | grep -q "^app 127.0.0.1:$PORT->3000/tcp$"
}

# By label, so a failed lookup cannot pass as "no container". The app lookup
# proves the same filter finds this project's containers.
service_containers() {
  dk ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1"
}
no_dev_inngest() {
  local app inngest
  app="$(service_containers app)" && inngest="$(service_containers inngest)" && [ -n "$app" ] && [ -z "$inngest" ]
}
migrate_succeeded() { dc ps -a --format '{{.Service}} {{.ExitCode}}' | grep -qx 'migrate 0'; }
reference_seeded() { [ "$(psql_q 'select count(*) from reference_values where org_id is null')" -ge 6 ]; }
unsigned_inngest_refused() { [ "$(http_code '/api/inngest?fnId=recruvault-publish-outbox&stepId=step' POST)" = "401" ]; }

outbox_published() { [ "$(psql_q "select state from outbox_events where dedupe_key = '$1'")" = "published" ]; }
jobs_publish() {
  local key
  key="proof-$(hex 8)"
  psql_q "insert into outbox_events (event_name, payload, dedupe_key) values ('proof/ping', '{}'::jsonb, '$key')" &&
    wait_until 180 outbox_published "$key"
}
jobs_backlog_visible() {
  psql_q "insert into outbox_events (event_name, payload, dedupe_key, created_at, available_at)
          values ('proof/ping', '{}'::jsonb, 'proof-$(hex 8)', now() - interval '20 minutes', now() + interval '1 hour')" &&
    wait_until 30 health_is "200 degraded ok ok unavailable backlog"
}

# Must fail because the database refuses the credentials, not for another
# reason. drizzle-kit exits 1 without printing the cause; PostgreSQL logs it.
failing_migration_exits() {
  local bad
  bad="$(hex 16)"
  echo "$bad" >>"$REDACT"
  if dc run --rm --no-deps -e "DATABASE_URL=postgres://proof_invalid:$bad@db:5432/recruvault" migrate; then
    return 1
  fi
  dc logs --no-color db 2>&1 | grep -q 'password authentication failed for user "proof_invalid"'
}

# -- proof --------------------------------------------------------------------

echo "commit $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- || echo '+uncommitted'), context $CTX, project $PROJECT"

check "production compose renders with every secret set" prod_renders
# BOOTSTRAP_TOKEN is set and used below, but production may run without it.
for name in LOCAL_KEK BETTER_AUTH_SECRET POSTGRES_PASSWORD MINIO_ROOT_PASSWORD INNGEST_SIGNING_KEY; do
  check "production compose refuses a missing $name" missing_secret_refused "$name"
done

check "images build" dc --profile proof build app migrate mock-resend proof-driver
echo "image $(dk image inspect -f '{{.Id}}' "$PROJECT-app" 2>/dev/null | cut -c1-19)"
# Blocks until migrate and minio-init finish and the scanner, then the app,
# report healthy. ClamAV's healthcheck bounds the wait (about 10 minutes).
check "fresh stack starts" dc up -d app tls-proxy inngest-server
check "migrations and seed exit 0 before the app starts" migrate_succeeded
check "reference data is seeded" reference_seeded
check "only the app port is published, on 127.0.0.1" only_app_published
check "Inngest dev server is not running" no_dev_inngest
check "readiness reports ok for database, storage, scanner, and jobs" wait_until 60 health_is "200 ok ok ok ok ok"
check "liveness answers" wait_until 10 live_ok
check "unsigned calls to the Inngest endpoint are refused" unsigned_inngest_refused

driver onboard || FAILED=$((FAILED + 1))
check "signed self-hosted Inngest publishes queued outbox events" jobs_publish

check "app restarts healthy" restart_app
driver after-restart || FAILED=$((FAILED + 1))

check "scanner stopped" dc stop clamav
check "readiness reports degraded with the scanner down" wait_until 60 health_is "200 degraded ok ok unavailable ok"

check "email provider stopped" dc stop mock-resend
driver email-down || FAILED=$((FAILED + 1))

check "Inngest stopped" dc stop inngest-server
check "readiness reports a job backlog while Inngest is down" jobs_backlog_visible

check "migration with bad database credentials exits non-zero" failing_migration_exits

check "database stopped" dc stop db
check "readiness returns 503 without the database" wait_until 60 readiness_unavailable
check "liveness still answers without the database" live_ok
