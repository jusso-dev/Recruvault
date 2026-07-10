#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Recruvault MCP server. Wraps the v1 REST API for recruiter and job-seeker
 * agents. The API key determines which tools can access data.
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

server.registerTool(
  "get_recruiter_report",
  {
    title: "Get recruiter operations report",
    description:
      "Get a detailed, read-only recruiter report covering active and unfilled roles, last-month applications, job seekers still owing information, stage aging, application velocity, matched-alert performance, candidates needing action, deadlines, and prioritised work for this week. Use this tool for workload, caseload, outstanding-information, placement, trend, risk, and priority questions.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api("/reports/recruiter"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_applications",
  {
    title: "List my applications",
    description: "List the authenticated job seeker's applications and current placement stages.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api("/me/applications"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_career_documents",
  {
    title: "List my career documents",
    description: "List resume and cover-letter metadata and security-scan state for the authenticated job seeker.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api("/me/documents"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_profile",
  {
    title: "Get my discovery profile",
    description: "Read the authenticated job seeker's recruiter-discovery preferences.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api("/me/profile"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "update_profile",
  {
    title: "Update my discovery profile",
    description:
      "Update discoverability, clearance level, skills, and general location. Identity and background-check information is not accepted.",
    inputSchema: {
      discoverable: z.boolean().optional(),
      clearanceLevel: z.enum(["baseline", "nv1", "nv2", "pv", "tspa"]).nullable().optional(),
      skills: z.array(z.string()).max(30).optional(),
      location: z.string().max(120).nullable().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await api("/me/profile", { method: "PATCH", body: args }));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
