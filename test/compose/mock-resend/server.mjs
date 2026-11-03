// Test-only stand-in for the Resend HTTP API, used by the Compose install
// proof. The production image sends real `POST /emails` calls here because the
// proof sets RESEND_BASE_URL. Messages are held in memory and exposed on the
// internal network only, so the proof driver can follow the verification link
// a person would receive. Never deploy this.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const apiKey = process.env.MOCK_RESEND_API_KEY;
if (!apiKey) {
  console.error("MOCK_RESEND_API_KEY is required");
  process.exit(1);
}
const messages = [];

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock-resend");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return reply(res, 200, { ok: true });

    if (req.method === "POST" && url.pathname === "/emails") {
      // Same contract as Resend: the configured API key or a 401.
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        return reply(res, 401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
      }
      const body = await readJson(req);
      const to = [body.to].flat().filter(Boolean).map((a) => String(a).toLowerCase());
      if (!body.from || to.length === 0 || !body.subject) {
        return reply(res, 422, { statusCode: 422, name: "validation_error", message: "from, to, and subject are required" });
      }
      const id = randomUUID();
      messages.push({ id, from: body.from, to, subject: body.subject, text: body.text ?? "", createdAt: Date.now() });
      console.log(`accepted message ${messages.length}`);
      return reply(res, 200, { id });
    }

    if (req.method === "GET" && url.pathname === "/proof/messages") {
      const to = url.searchParams.get("to")?.toLowerCase();
      return reply(res, 200, messages.filter((m) => !to || m.to.includes(to)));
    }

    reply(res, 404, { statusCode: 404, name: "not_found", message: "Not found" });
  } catch {
    reply(res, 400, { statusCode: 400, name: "invalid_request", message: "Bad request" });
  }
}).listen(8025, "0.0.0.0", () => console.log("mock resend listening"));
