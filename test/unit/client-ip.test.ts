import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "@/lib/client-ip";

const headers = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it("takes the address appended by the single trusted proxy by default", () => {
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("ignores client-supplied entries in front of the trusted hops", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(headers("6.6.6.6, 203.0.113.9, 10.0.0.2"))).toBe("203.0.113.9");
  });

  it("reports unknown when the chain is shorter than the trusted hops", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(headers("203.0.113.9"))).toBe("unknown");
    expect(clientIp(headers())).toBe("unknown");
  });

  it("never trusts the header with no proxy configured", () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    expect(clientIp(headers("203.0.113.9"))).toBe("untrusted");
  });
});
