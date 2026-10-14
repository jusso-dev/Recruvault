import { getLogger } from "@/lib/logger";

/**
 * Operator tooling for the transactional outbox. Prints metadata only: ids,
 * event names, states, attempts, timestamps, and the bounded (already
 * redacted) last error. Never payloads, dedupe keys, recipients, or keys.
 *
 *   npm run outbox -- stats
 *   npm run outbox -- list [pending|dead|published] [limit]
 *   npm run outbox -- retry <id> [<id> ...]
 *   npm run outbox -- retry-dead
 *   npm run outbox -- reconcile
 *   npm run outbox -- prune
 */

const USAGE = "usage: npm run outbox -- stats | list [state] [limit] | retry <id...> | retry-dead | reconcile | prune";

async function main() {
  const outbox = await import("@/lib/outbox");
  const [command = "stats", ...args] = process.argv.slice(2);
  switch (command) {
    case "stats":
      return outbox.outboxStats();
    case "list":
      return outbox.listOutbox({ state: args[0] ?? "dead", limit: Number(args[1] ?? 50) });
    case "retry":
      if (args.length === 0) throw new Error(USAGE);
      return { requeued: await outbox.requeueDead(args) };
    case "retry-dead":
      return { requeued: await outbox.requeueDead() };
    case "reconcile":
      return { enqueued: await outbox.reconcileOutbox() };
    case "prune":
      return { deleted: await outbox.pruneOutbox() };
    default:
      throw new Error(USAGE);
  }
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    getLogger("outbox-cli").error({ err: error }, "outbox command failed");
    process.exit(1);
  });
