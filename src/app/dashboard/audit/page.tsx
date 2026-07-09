import { requireOrgUser } from "@/lib/guards";
import { listAuditEvents, verifyChain } from "@/lib/audit";
import { Badge, Card, CardContent } from "@/components/ui";

export default async function AuditPage() {
  const ctx = await requireOrgUser("audit:view");
  const [events, integrity] = await Promise.all([
    listAuditEvents(ctx.orgId, 500),
    verifyChain(ctx.orgId),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Audit trail</h1>
        <Badge variant={integrity.ok ? "green" : "red"}>
          {integrity.ok
            ? "Hash chain intact"
            : `TAMPERING DETECTED at seq ${integrity.brokenAtSeq}`}
        </Badge>
      </div>
      <p className="text-sm text-zinc-500">
        Append-only and hash-chained. Events reference records by id only — no PII is
        ever written to the log, so it survives retention purges as a metadata-only
        record of handling.
      </p>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2">Seq</th>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 tabular-nums text-zinc-400">{e.seq}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {e.createdAt.toLocaleString("en-AU")}
                  </td>
                  <td className="px-4 py-2">{e.actorType}</td>
                  <td className="px-4 py-2 font-medium">{e.action}</td>
                  <td className="px-4 py-2 text-zinc-500">
                    {e.targetType}
                    {e.targetId && (
                      <span className="ml-1 font-mono text-xs">
                        {e.targetId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{e.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && (
            <p className="p-6 text-center text-sm text-zinc-500">No events yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
