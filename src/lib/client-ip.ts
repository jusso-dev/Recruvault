/**
 * Client IP for rate limiting and audit metadata. `x-forwarded-for` is
 * client-controlled except for the entries appended by our own proxies, so
 * take the entry TRUSTED_PROXY_HOPS from the end (default 1: one reverse
 * proxy in front). With 0 the header is ignored and "untrusted" is returned.
 */
export function clientIp(headers: Pick<Headers, "get">): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  if (!Number.isInteger(hops) || hops < 1) return "untrusted";
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain[chain.length - hops] ?? "unknown";
}
