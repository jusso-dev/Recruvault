// Env required by modules under test at import time. No real secrets — these
// are deterministic test values so signing/HMAC paths are exercisable.
process.env.LINK_SESSION_SECRET ??= "test-link-session-secret";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
// 32 bytes of hex so the local-KEK path in crypto.ts is usable if reached.
process.env.LOCAL_KEK ??= "00".repeat(32);
