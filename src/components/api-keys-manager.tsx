"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createApiKey, revokeApiKey } from "@/actions/api-keys";
import { Button, Input } from "@/components/ui";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export function ApiKeysManager({ keys }: { keys: ApiKeyRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    startTransition(async () => {
      const res = await createApiKey(fd);
      if (!res.ok || !res.key) {
        setError(res.error ?? "Could not create the key.");
        return;
      }
      setCreated(res.key);
      form.reset();
      router.refresh();
    });
  }

  function onRevoke(id: string) {
    const fd = new FormData();
    fd.set("keyId", id);
    startTransition(async () => {
      await revokeApiKey(fd);
      router.refresh();
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
              </div>
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

      <form onSubmit={onCreate} className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="apiKeyName" className="mb-1.5 block text-sm font-medium text-stone-700">
            New key name
          </label>
          <Input id="apiKeyName" name="name" placeholder="Codex on my laptop" required />
        </div>
        <Button type="submit" disabled={pending}>
          Create key
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <p className="text-xs text-stone-500">
        Keys authenticate the REST API and the MCP server. They carry your role;
        treat them like a password.
      </p>
    </div>
  );
}
