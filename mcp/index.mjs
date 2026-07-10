#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Recruvault MCP server. Wraps the Recruvault v1 REST API so a recruiter's
 * agent (Claude Code, Codex) can create requests, upload job descriptions,
 * find opted-in candidates, and send secure links.
 *
 * Config (env):
 *   RECRUVAULT_URL       base URL (default http://localhost:3000)
 *   RECRUVAULT_API_KEY   an rv_ API key from Settings -> API keys (required)
 */

const BASE = (process.env.RECRUVAULT_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.RECRUVAULT_API_KEY;
if (!API_KEY) {
  console.error("RECRUVAULT_API_KEY is required.");
  process.exit(1);
}

async function api(path, { method = "GET", body, formData } = {}) {
  const headers = { Authorization: `Bearer ${API_KEY}` };
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${data.error ?? res.statusText}`);
  }
  return data;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
});

const server = new McpServer({ name: "recruvault", version: "1.0.0" });

server.registerTool(
  "create_request",
  {
    title: "Create a secure request",
    description:
      "Create a request that collects clearance/identity/right-to-work evidence. Resume + suitability statement are added by default.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      fieldKeys: z.array(z.string()).optional(),
      customLabels: z.array(z.string()).optional(),
      listed: z.boolean().optional(),
      expiresAt: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await api("/requests", { method: "POST", body: args }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "upload_jd",
  {
    title: "Upload a job description",
    description: "Attach a PDF or Word (.docx) job description to a request from a local file path.",
    inputSchema: { requestId: z.string(), filePath: z.string() },
  },
  async ({ requestId, filePath }) => {
    try {
      const bytes = await readFile(filePath);
      const fd = new FormData();
      fd.set("jd", new Blob([bytes]), basename(filePath));
      return ok(await api(`/requests/${requestId}/jd`, { method: "POST", formData: fd }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "find_candidates",
  {
    title: "Find matching candidates",
    description:
      "Match a role's requirements against opted-in job seekers. Returns opaque handles and match detail only (no PII).",
    inputSchema: {
      clearanceLevel: z.enum(["baseline", "nv1", "nv2", "pv", "tspa"]).optional(),
      citizenship: z.string().optional(),
      rightToWork: z.string().optional(),
      skills: z.array(z.string()).optional(),
      limit: z.number().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await api("/match", { method: "POST", body: args }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "send_request",
  {
    title: "Send a secure link",
    description:
      "Send a request's secure link to an email address or a candidate handle from find_candidates.",
    inputSchema: {
      requestId: z.string(),
      email: z.string().optional(),
      candidateHandle: z.string().optional(),
    },
  },
  async ({ requestId, email, candidateHandle }) => {
    try {
      return ok(
        await api(`/requests/${requestId}/send`, {
          method: "POST",
          body: { email, candidateHandle },
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_requests",
  { title: "List requests", description: "List the organisation's requests.", inputSchema: {} },
  async () => {
    try {
      return ok(await api("/requests"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_submissions",
  {
    title: "Get submissions",
    description: "List submission metadata for a request.",
    inputSchema: { requestId: z.string() },
  },
  async ({ requestId }) => {
    try {
      return ok(await api(`/requests/${requestId}/submissions`));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
