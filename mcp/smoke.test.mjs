import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Protocol smoke test: runs index.mjs over stdio against a mock Recruvault
 * API and checks that only the tools the key's scopes allow are registered,
 * and that API errors come back as actionable tool errors.
 */

const SERVER = fileURLToPath(new URL("./index.mjs", import.meta.url));
const KEY = "rv_smoke_test_key_not_real";

function mockApi(keyDescription, routes = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const route = req.url === "/api/v1/me/key" ? keyDescription : routes[`${req.method} ${req.url}`];
    const { status = 200, body = {}, headers = {} } = route ?? { status: 404, body: { error: "Not found." } };
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

async function connect(url) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, RECRUVAULT_URL: url, RECRUVAULT_API_KEY: KEY },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

test("a reporting key exposes only read tools and write errors are actionable", async () => {
  const api = await mockApi(
    { body: { key: { kind: "organisation", scopes: ["reports:read", "roles:read"], expiresAt: null } } },
    {
      "GET /api/v1/requests": { status: 403, body: { error: "Your role does not allow this action (requests:create)." } },
      "GET /api/v1/reports/recruiter": {
        status: 429,
        body: { error: "Too many requests." },
        headers: { "retry-after": "17" },
      },
    },
  );
  const client = await connect(api.url);
  try {
    assert.deepEqual(await toolNames(client), ["get_key_info", "get_recruiter_report", "list_requests"]);

    const denied = await client.callTool({ name: "list_requests", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /403/);
    assert.match(denied.content[0].text, /Required scope: roles:read/);

    const limited = await client.callTool({ name: "get_recruiter_report", arguments: {} });
    assert.equal(limited.isError, true);
    assert.match(limited.content[0].text, /Retry after 17 seconds/);

    const info = await client.callTool({ name: "get_key_info", arguments: {} });
    assert.match(info.content[0].text, /reports:read/);
    assert.doesNotMatch(info.content[0].text, new RegExp(KEY));
    assert.ok(api.calls.every((call) => call.auth === `Bearer ${KEY}`));
  } finally {
    await client.close();
    api.server.close();
  }
});

test("a job-seeker key never exposes recruiter tools", async () => {
  const api = await mockApi({
    body: { key: { kind: "candidate", scopes: ["profile:read", "profile:write"], expiresAt: null } },
  });
  const client = await connect(api.url);
  try {
    assert.deepEqual(await toolNames(client), ["get_key_info", "get_profile", "update_profile"]);
  } finally {
    await client.close();
    api.server.close();
  }
});

test("an invalid key stops startup with replacement guidance", async () => {
  const api = await mockApi({ status: 401, body: { error: "Invalid, expired, or revoked API key." } });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, RECRUVAULT_URL: api.url, RECRUVAULT_API_KEY: KEY },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await assert.rejects(client.connect(transport));
  assert.match(stderr, /could not start: 401/);
  assert.match(stderr, /Create a new key/);
  assert.doesNotMatch(stderr, new RegExp(KEY));
  api.server.close();
});
