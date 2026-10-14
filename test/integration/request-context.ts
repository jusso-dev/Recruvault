import { AsyncLocalStorage } from "async_hooks";

/**
 * A per-call stand-in for `next/headers` so Server Actions and BetterAuth run
 * against a real database outside Next.js. Each simulated browser is a cookie
 * jar; `asBrowser` runs a callback as that browser. Synthetic values only.
 */
export interface Browser {
  ip: string;
  jar: Map<string, string>;
}

const store = new AsyncLocalStorage<Browser>();
let counter = 0;

export function newBrowser(): Browser {
  counter += 1;
  return { ip: `198.51.100.${counter % 250}`, jar: new Map() };
}

export function asBrowser<T>(browser: Browser, fn: () => Promise<T>): Promise<T> {
  return store.run(browser, fn);
}

function current(): Browser {
  const browser = store.getStore();
  if (!browser) throw new Error("No simulated request in scope.");
  return browser;
}

export function cookieHeader(browser: Browser) {
  return [...browser.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function requestHeaders(browser: Browser) {
  return new Headers({
    cookie: cookieHeader(browser),
    "x-forwarded-for": browser.ip,
    "user-agent": "integration-test",
    origin: "http://localhost:3000",
  });
}

/** Apply Set-Cookie headers from a BetterAuth response to the jar. */
export function absorbCookies(browser: Browser, response: Response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired = attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()));
    if (!value || expired) browser.jar.delete(name);
    else browser.jar.set(name, value);
  }
}

/** Call the real BetterAuth HTTP handler as this browser. */
export async function authRequest(
  browser: Browser,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const { auth } = await import("@/lib/auth");
  const headers = requestHeaders(browser);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await asBrowser(browser, () =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    ),
  );
  absorbCookies(browser, response);
  return response;
}

export const nextHeadersMock = {
  headers: async () => requestHeaders(current()),
  cookies: async () => {
    const browser = current();
    return {
      get: (name: string) => (browser.jar.has(name) ? { name, value: browser.jar.get(name)! } : undefined),
      getAll: () => [...browser.jar.entries()].map(([name, value]) => ({ name, value })),
      has: (name: string) => browser.jar.has(name),
      set: (name: string | { name: string; value: string }, value?: string) => {
        if (typeof name === "object") browser.jar.set(name.name, name.value);
        else browser.jar.set(name, value ?? "");
      },
      delete: (name: string) => browser.jar.delete(name),
    };
  },
};

/** Captured auth emails (verification/reset links). Never real addresses. */
export const outbox: { to: string; ctaUrl?: string }[] = [];

export const emailMock = {
  sendAuthEmail: async (message: { to: string; ctaUrl?: string }) => {
    outbox.push({ to: message.to, ctaUrl: message.ctaUrl });
  },
  sendEmail: async () => null,
  sendRequestInvite: async () => null,
  sendOtpEmail: async () => null,
  sendSubmissionReceived: async () => null,
  sendRecruiterSubmissionAlert: async () => null,
  sendJobMatchAlert: async () => null,
  sendExpiryReminder: async () => null,
  sendErasureConfirmation: async () => null,
  fromAddress: () => "Recruvault <test@example.invalid>",
};

/** Sign up with the real endpoint, then follow the emailed verification link. */
export async function signUpVerified(
  browser: Browser,
  email: string,
  options: { verify?: boolean; accountType?: string } = {},
) {
  const response = await authRequest(browser, "/sign-up/email", {
    body: { name: "Test Person", email, password: "correct-horse-battery", ...(options.accountType ? { accountType: options.accountType } : {}) },
  });
  if (!response.ok) return response;
  if (options.verify === false) return response;
  const link = [...outbox].reverse().find((message) => message.to === email)?.ctaUrl;
  if (!link) throw new Error("No verification link captured.");
  const url = new URL(link);
  return authRequest(browser, `${url.pathname.replace(/^\/api\/auth/, "")}${url.search}`);
}
