#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Recruvault MCP server. Wraps the v1 REST API for recruiter and job-seeker
 * agents. At startup it asks the API which kind of key it holds and which
 * scopes it carries, and registers only the tools that key can use.
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

const HINTS = {
  401: "The API key is invalid, expired, revoked, or a legacy key. Create a new key in Recruvault (API & MCP) and update RECRUVAULT_API_KEY.",
  403: "The key's scopes, your current role, email verification, or encryption enrollment does not allow this. Create a key with the required scope or ask an organisation admin.",
};

async function api(path, { method = "GET", body, formData, scope } = {}) {
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
    let hint = HINTS[res.status] ?? "";
    if (res.status === 403 && scope) hint += ` Required scope: ${scope}.`;
    if (res.status === 429) {
      hint = `Rate limited. Retry after ${res.headers.get("retry-after") ?? "60"} seconds.`;
    }
    const message = String(data.error ?? res.statusText).replace(/\.$/, "");
    throw new Error(`${res.status} ${message}. ${hint}`.trim());
  }
  return data;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
});

let key;
try {
  ({ key } = await api("/me/key"));
} catch (err) {
  console.error(`Recruvault MCP could not start: ${err.message}`);
  process.exit(1);
}

const granted = new Set(key.scopes);
const permits = (kind, scope) =>
  key.kind === kind && (granted.has(scope) || granted.has("legacy:full"));

const server = new McpServer({ name: "recruvault", version: "1.0.0" });

const registered = [];

/** Register a tool only when the key's kind and scopes allow it. */
function tool(name, { kind, scope, ...config }, handler) {
  if (!permits(kind, scope)) return;
  registered.push(name);
  server.registerTool(
    name,
    { ...config, description: `${config.description} Requires scope ${scope}.` },
    async (args) => {
      try {
        return ok(await handler(args ?? {}, scope));
      } catch (err) {
        return fail(err);
      }
    },
  );
}

const clearance = z.enum(["baseline", "nv1", "nv2", "pv", "tspa"]);

tool(
  "create_request",
  {
    kind: "organisation",
    scope: "roles:write",
    title: "Create a role",
    description:
      "Create a role that may request clearance level, clearance ID, resume, and cover letter/suitability statement. Resume and cover letter are added by default.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      employmentType: z.enum(["permanent", "contract", "fixed_term", "casual"]).optional(),
      workArrangement: z.enum(["on_site", "hybrid", "remote"]).optional(),
      salaryMin: z.number().int().nonnegative().optional(),
      salaryMax: z.number().int().nonnegative().optional(),
      salaryPeriod: z.enum(["annual", "daily", "hourly"]).optional(),
      skills: z.array(z.string().max(80)).max(30).optional(),
      fieldKeys: z
        .array(z.enum(["clearance_level", "clearance_id", "resume", "cover_letter"]))
        .optional(),
      listed: z.boolean().optional(),
      expiresAt: z.string().optional(),
    },
  },
  (args, scope) => api("/requests", { method: "POST", body: args, scope }),
);

tool(
  "upload_jd",
  {
    kind: "organisation",
    scope: "jd:write",
    title: "Upload a job description",
    description: "Attach a PDF or Word (.docx) job description to a request from a local file path.",
    inputSchema: { requestId: z.string(), filePath: z.string() },
  },
  async ({ requestId, filePath }, scope) => {
    const bytes = await readFile(filePath);
    const fd = new FormData();
    fd.set("jd", new Blob([bytes]), basename(filePath));
    return api(`/requests/${requestId}/jd`, { method: "POST", formData: fd, scope });
  },
);

tool(
  "find_candidates",
  {
    kind: "organisation",
    scope: "match:read",
    title: "Find matching candidates",
    description:
      "Match a role's requirements against opted-in job seekers. Returns opaque handles and match detail only (no PII).",
    inputSchema: {
      clearanceLevel: clearance.optional(),
      skills: z.array(z.string()).optional(),
      limit: z.number().optional(),
    },
  },
  (args, scope) => api("/match", { method: "POST", body: args, scope }),
);

tool(
  "send_request",
  {
    kind: "organisation",
    scope: "invitations:send",
    title: "Send a secure link",
    description:
      "Send a request's secure link to an email address or a candidate handle from find_candidates.",
    inputSchema: {
      requestId: z.string(),
      email: z.string().optional(),
      candidateHandle: z.string().optional(),
    },
  },
  ({ requestId, email, candidateHandle }, scope) =>
    api(`/requests/${requestId}/send`, { method: "POST", body: { email, candidateHandle }, scope }),
);

tool(
  "list_requests",
  {
    kind: "organisation",
    scope: "roles:read",
    title: "List requests",
    description: "List the organisation's requests.",
    inputSchema: {},
  },
  (_args, scope) => api("/requests", { scope }),
);

tool(
  "get_submissions",
  {
    kind: "organisation",
    scope: "submissions:read",
    title: "Get submissions",
    description: "List submission metadata for a request.",
    inputSchema: { requestId: z.string() },
  },
  ({ requestId }, scope) => api(`/requests/${requestId}/submissions`, { scope }),
);

tool(
  "get_recruiter_report",
  {
    kind: "organisation",
    scope: "reports:read",
    title: "Get recruiter operations report",
    description:
      "Get a detailed, read-only recruiter report covering active and unfilled roles, last-month applications, job seekers still owing information, stage aging, application velocity, matched-alert performance, candidates needing action, deadlines, and prioritised work for this week. Use this tool for workload, caseload, outstanding-information, placement, trend, risk, and priority questions.",
    inputSchema: {},
  },
  (_args, scope) => api("/reports/recruiter", { scope }),
);

tool(
  "list_applications",
  {
    kind: "candidate",
    scope: "applications:read",
    title: "List my applications",
    description: "List the authenticated job seeker's applications and current placement stages.",
    inputSchema: {},
  },
  (_args, scope) => api("/me/applications", { scope }),
);

tool(
  "list_career_documents",
  {
    kind: "candidate",
    scope: "documents:read",
    title: "List my career documents",
    description: "List resume and cover-letter metadata and security-scan state for the authenticated job seeker.",
    inputSchema: {},
  },
  (_args, scope) => api("/me/documents", { scope }),
);

tool(
  "get_profile",
  {
    kind: "candidate",
    scope: "profile:read",
    title: "Get my discovery profile",
    description: "Read the authenticated job seeker's recruiter-discovery preferences.",
    inputSchema: {},
  },
  (_args, scope) => api("/me/profile", { scope }),
);

tool(
  "update_profile",
  {
    kind: "candidate",
    scope: "profile:write",
    title: "Update my discovery profile",
    description:
      "Update discoverability, clearance level, skills, and general location. Identity and background-check information is not accepted.",
    inputSchema: {
      discoverable: z.boolean().optional(),
      clearanceLevel: clearance.nullable().optional(),
      skills: z.array(z.string()).max(30).optional(),
      location: z.string().max(120).nullable().optional(),
    },
  },
  (args, scope) => api("/me/profile", { method: "PATCH", body: args, scope }),
);

server.registerTool(
  "get_key_info",
  {
    title: "Describe this API key",
    description:
      "Show the key kind, scopes, expiry, and the tools it enables. Use it to explain why a tool is unavailable.",
    inputSchema: {},
  },
  async () => ok({ ...key, availableTools: registered }),
);

await server.connect(new StdioServerTransport());
