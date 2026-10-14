"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createApiKey,
  createCandidateApiKey,
  revokeApiKey,
  revokeCandidateApiKey,
  rotateApiKey,
  rotateCandidateApiKey,
} from "@/actions/api-keys";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";
import {
  CANDIDATE_API_SCOPES,
  CANDIDATE_READ_SCOPES,
  LEGACY_API_SCOPE,
  ORG_API_SCOPES,
  REPORTING_SCOPES,
  SCOPE_DESCRIPTIONS,
} from "@/lib/api-scopes";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes?: string[];
  expiresAt?: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const READ_ONLY_DEFAULTS = new Set<string>([...REPORTING_SCOPES, ...CANDIDATE_READ_SCOPES]);

export function ApiKeysManager({
  keys,
  scope = "organisation",
}: {
  keys: ApiKeyRow[];
  scope?: "organisation" | "candidate";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<string | null>(null);
  const { showToast } = useToast();

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    startTransition(async () => {
      try {
        const res =
          scope === "candidate" ? await createCandidateApiKey(fd) : await createApiKey(fd);
        if (!res.ok || !res.key) {
          showToast({
            tone: "error",
            message: userFacingError(res.error, "We couldn’t create the API key. Please try again."),
          });
          return;
        }
        setCreated(res.key);
        form.reset();
        showToast({
          tone: "success",
          message: "API key created. Copy it now because it won’t be shown again.",
        });
        router.refresh();
      } catch (error) {
        showToast({ tone: "error", message: userFacingError(error) });
      }
    });
  }

  function onRotate(id: string) {
    const fd = new FormData();
    fd.set("keyId", id);
    const password = (document.getElementById("apiKeyPassword") as HTMLInputElement | null)?.value;
    if (password) fd.set("password", password);
    const ttl = (document.getElementById("ttlDays") as HTMLInputElement | null)?.value;
    if (ttl) fd.set("ttlDays", ttl);
    startTransition(async () => {
      try {
        const res =
          scope === "candidate" ? await rotateCandidateApiKey(fd) : await rotateApiKey(fd);
        if (!res.ok || !res.key) {
          showToast({ tone: "error", message: userFacingError(res.error) });
          return;
        }
        setCreated(res.key);
        showToast({
          tone: "success",
          message: "Key rotated. The old key no longer works. Copy the new one now.",
        });
        router.refresh();
      } catch (error) {
        showToast({ tone: "error", message: userFacingError(error) });
      }
    });
  }

  function onRevoke(id: string) {
    const fd = new FormData();
    fd.set("keyId", id);
    startTransition(async () => {
      try {
        const res =
          scope === "candidate" ? await revokeCandidateApiKey(fd) : await revokeApiKey(fd);
        if (!res.ok) {
          showToast({ tone: "error", message: userFacingError(res.error) });
          return;
        }
        showToast({ tone: "success", message: "API key revoked." });
        router.refresh();
      } catch (error) {
        showToast({ tone: "error", message: userFacingError(error) });
      }
    });
  }

  return (
    <div className="space-y-4">
      {created && (
        <div className="rounded-md border border-accent-tint-border bg-accent-tint p-3">
          <p className="text-sm font-medium text-accent">
            Copy your key now. It will not be shown again.
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-white px-2 py-1.5 font-mono text-xs text-stone-900">
            {created}
          </code>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="divide-y divide-stone-100">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-stone-900">{k.name}</span>
                <span className="ml-2 font-mono text-xs text-stone-500">{k.prefix}…</span>
                <span className="ml-2 text-xs text-stone-400">
                  {k.lastUsedAt
                    ? `last used ${new Date(k.lastUsedAt).toLocaleDateString("en-AU")}`
                    : "never used"}
                </span>
                {k.expiresAt && (
                  <span className="ml-2 text-xs text-stone-400">
                    expires {new Date(k.expiresAt).toLocaleDateString("en-AU")}
                  </span>
                )}
                {k.scopes && (
                  <span className="block text-xs text-stone-500">
                    {k.scopes.includes(LEGACY_API_SCOPE)
                      ? "Legacy key: no longer accepted. Create a new scoped key and revoke this one."
                      : k.scopes.join(", ")}
                  </span>
                )}
              </div>
              {!k.scopes?.includes(LEGACY_API_SCOPE) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRotate(k.id)}
                  disabled={pending}
                >
                  Rotate
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRevoke(k.id)}
                disabled={pending}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onCreate} className="space-y-3">
        <div>
          <label htmlFor="apiKeyName" className="mb-1.5 block text-sm font-medium text-stone-700">
            New key name
          </label>
          <Input id="apiKeyName" name="name" placeholder="Codex on my laptop" required />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-stone-700">Scopes</legend>
          {(scope === "candidate" ? CANDIDATE_API_SCOPES : ORG_API_SCOPES).map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                name="scopes"
                value={item}
                defaultChecked={READ_ONLY_DEFAULTS.has(item)}
              />
              <span className="font-mono text-xs">{item}</span>
              <span className="text-stone-500">{SCOPE_DESCRIPTIONS[item]}</span>
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor="ttlDays" className="mb-1.5 block text-sm font-medium text-stone-700">
            Expires in days
          </label>
          <Input id="ttlDays" name="ttlDays" type="number" min={1} max={365} defaultValue={90} required />
        </div>
        <div>
          <label htmlFor="apiKeyPassword" className="mb-1.5 block text-sm font-medium text-stone-700">
            Current password
          </label>
          <Input
            id="apiKeyPassword"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Not needed if you signed in within 15 minutes"
          />
        </div>
        <Button type="submit" disabled={pending}>
          Create key
        </Button>
      </form>
      <p className="text-xs text-stone-500">
        Keys expire, carry only the scopes you check (read-only reporting by default), and cannot
        exceed your live role. Creating or rotating a key needs your password or a sign-in from the
        last 15 minutes, and an unlocked encryption key. The secret is shown once. Treat it like a
        password. Keys made before scoped keys existed are not upgraded and must be replaced.
      </p>
    </div>
  );
}
