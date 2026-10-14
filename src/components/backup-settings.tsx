"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runBackupNow, updateBackupSettings } from "@/actions/backup";
import { Button, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

export function BackupSettings({
  config,
  runs,
}: {
  config: {
    enabled: boolean;
    hourUtc: number;
    retainCount: number;
    r2AccountId: string;
    r2Bucket: string;
    r2AccessKeyId: string;
    hasSecret: boolean;
    hasBackupKey: boolean;
  } | null;
  runs: {
    id: string;
    trigger: string;
    status: string;
    sizeBytes: number | null;
    startedAt: Date | string;
    finishedAt: Date | string | null;
    error: string | null;
  }[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [backupKey, setBackupKey] = useState<string | null>(null);

  function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      try {
        const result = await updateBackupSettings(data);
        if (!result.ok) {
          showToast({ tone: "error", message: userFacingError(result.error) });
          return;
        }
        if (result.backupKey) setBackupKey(result.backupKey);
        form.querySelector<HTMLInputElement>("#r2SecretAccessKey")!.value = "";
        showToast({ tone: "success", message: "Backup settings saved." });
        router.refresh();
      } catch (error) {
        showToast({ tone: "error", message: userFacingError(error) });
      }
    });
  }

  function onRun() {
    startTransition(async () => {
      try {
        const result = await runBackupNow();
        if (!result.ok) {
          showToast({ tone: "error", message: userFacingError(result.error) });
          return;
        }
        showToast({ tone: "success", message: "Encrypted backup uploaded to R2." });
        router.refresh();
      } catch (error) {
        showToast({ tone: "error", message: userFacingError(error) });
      }
    });
  }

  return (
    <div className="space-y-4">
      {backupKey && (
        <div className="rounded-md border border-accent-tint-border bg-accent-tint p-3">
          <p className="text-sm font-medium text-accent">
            Copy the backup key now. It will not be shown again.
          </p>
          <p className="mt-1 text-xs leading-5 text-stone-600">
            This key opens the R2 archives. It is not the workspace encryption key, and it
            does not replace one. Anyone who has this key and a backup file can read that
            archive offline, including candidate metadata and stored document bytes. Keep it
            outside email, chat, the database, and the R2 bucket. The server keeps a wrapped
            copy so nightly backups can still run. If you lose this key and also lose
            LOCAL_KEK, every backup already in R2 is unreadable and cannot be restored.
            The live workspace keeps working, but there is no way back from those archives.
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-white px-2 py-1.5 font-mono text-xs text-stone-900">
            {backupKey}
          </code>
        </div>
      )}

      <form onSubmit={onSave} className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={config?.enabled ?? false} />
          Upload an encrypted backup to R2 every night
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="hourUtc">Hour (UTC)</Label>
            <Input id="hourUtc" name="hourUtc" type="number" min={0} max={23} required defaultValue={config?.hourUtc ?? 16} />
          </div>
          <div>
            <Label htmlFor="retainCount">Backups to keep</Label>
            <Input id="retainCount" name="retainCount" type="number" min={1} max={90} required defaultValue={config?.retainCount ?? 14} />
          </div>
        </div>
        <div>
          <Label htmlFor="r2AccountId">Cloudflare account id</Label>
          <Input id="r2AccountId" name="r2AccountId" required defaultValue={config?.r2AccountId ?? ""} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="r2Bucket">R2 bucket</Label>
          <Input id="r2Bucket" name="r2Bucket" required defaultValue={config?.r2Bucket ?? ""} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="r2AccessKeyId">R2 access key id</Label>
          <Input id="r2AccessKeyId" name="r2AccessKeyId" required defaultValue={config?.r2AccessKeyId ?? ""} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="r2SecretAccessKey">R2 secret access key</Label>
          <Input
            id="r2SecretAccessKey"
            name="r2SecretAccessKey"
            type="password"
            autoComplete="new-password"
            placeholder={config?.hasSecret ? "Saved. Enter a new secret to replace it." : ""}
            required={!config?.hasSecret}
          />
        </div>
        <Button type="submit" disabled={pending}>Save backup settings</Button>
      </form>

      <p className="text-xs leading-5 text-stone-500">
        The archive is encrypted before it is uploaded. R2 never receives the database
        or document bytes in the clear. Workspace encryption keys are not in the backup,
        so a backup cannot recover a lost workspace key. A backup taken before a deletion
        can still contain that ciphertext. The default hour, 16 UTC, is 02:00 in Sydney
        outside daylight saving.
      </p>

      <Button type="button" variant="secondary" onClick={onRun} disabled={pending || !config?.hasBackupKey}>
        Back up now
      </Button>

      {runs.length > 0 && (
        <ul className="divide-y divide-stone-100 text-sm">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {run.status} · {run.trigger} · {new Date(run.startedAt).toLocaleString("en-AU")}
                {run.sizeBytes ? ` · ${Math.ceil(run.sizeBytes / 1024)} KB` : ""}
              </span>
              {run.error && <span className="text-xs text-stone-500">{run.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
