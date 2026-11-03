#!/bin/sh
# Trust the proof TLS proxy's throwaway CA (Caddy's internal root, published
# to the shared proof-ca volume) for Chromium (NSS) and Node, then run the driver. TLS
# verification stays on: only this one root is added.
set -eu
root=/ca/root.crt
i=0
until [ -s "$root" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "FAIL proof TLS root certificate was issued"; exit 1; fi
  sleep 1
done
mkdir -p "$HOME/.pki/nssdb"
[ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n rv-proof-root -i "$root"
export NODE_EXTRA_CA_CERTS="$root"
exec node /proof/driver.mjs "$@"
