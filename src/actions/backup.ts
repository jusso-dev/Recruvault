"use server";

import { revalidatePath } from "next/cache";
import { requireOrgUser, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { validateBackupForm } from "@/lib/backup-crypto";
import { getPublicBackupConfig, runBackup, saveBackupConfig } from "@/lib/backup";
import { sanitizeForTelemetry } from "@/lib/redact";
import type { ActionResult } from "@/actions/org";

async function owner() {
  const ctx = await requireOrgUser("org:manage");
  if (ctx.role !== "owner") return { ok: false as const, error: "Only an organisation owner can configure backups." };
  return { ok: true as const, ctx };
}

export async function updateBackupSettings(
  formData: FormData,
): Promise<ActionResult & { backupKey?: string }> {
  const access = await owner();
  if (!access.ok) return access;
  const existing = await getPublicBackupConfig();
  const parsed = validateBackupForm({
    enabled: formData.get("enabled") === "on",
    hourUtc: Number(formData.get("hourUtc") ?? 16),
    retainCount: Number(formData.get("retainCount") ?? 14),
    r2AccountId: String(formData.get("r2AccountId") ?? "").trim(),
    r2Bucket: String(formData.get("r2Bucket") ?? "").trim(),
    r2AccessKeyId: String(formData.get("r2AccessKeyId") ?? "").trim(),
    r2Secret: String(formData.get("r2SecretAccessKey") ?? "").trim(),
    hasExistingSecret: Boolean(existing?.hasSecret),
  });
  if (!parsed.ok) return parsed;

  try {
    const saved = await saveBackupConfig({
      enabled: parsed.value.enabled,
      hourUtc: parsed.value.hourUtc,
      retainCount: parsed.value.retainCount,
      r2AccountId: parsed.value.r2AccountId,
      r2Bucket: parsed.value.r2Bucket,
      r2AccessKeyId: parsed.value.r2AccessKeyId,
      r2Secret: parsed.value.r2Secret || undefined,
      updatedBy: access.ctx.userId,
    });
    const meta = await requestMeta();
    await audit({
      orgId: access.ctx.orgId,
      actorType: "org_user",
      actorId: access.ctx.userId,
      action: "backup.configured",
      targetType: "backup_config",
      targetId: "platform",
      ...meta,
    });
    revalidatePath("/dashboard/settings");
    return { ok: true, backupKey: saved.backupKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the backup settings.";
    return { ok: false, error: String(sanitizeForTelemetry(message)).slice(0, 240) };
  }
}

export async function runBackupNow(): Promise<ActionResult> {
  const access = await owner();
  if (!access.ok) return access;
  const result = await runBackup("manual");
  revalidatePath("/dashboard/settings");
  if (!result.ok) return result;
  return { ok: true, id: result.id };
}
