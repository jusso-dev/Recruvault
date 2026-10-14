/**
 * Hand-authored OpenAPI 3.1 document for the Recruvault v1 REST API. Kept as a
 * plain object (no build-time generation) so it stays dependency-light and is
 * served verbatim at /api/v1/openapi.json.
 */
import type { ApiScope } from "@/lib/api-scopes";

// Scope each operation requires. A key must hold the scope, and the creator's
// live role must allow the action.
const OPERATION_SCOPES: Record<string, ApiScope | null> = {
  "get /requests": "roles:read",
  "post /requests": "roles:write",
  "get /requests/{id}": "roles:read",
  "post /requests/{id}/jd": "jd:write",
  "get /requests/{id}/submissions": "submissions:read",
  "post /requests/{id}/send": "invitations:send",
  "get /reports/recruiter": "reports:read",
  "post /match": "match:read",
  "get /me/applications": "applications:read",
  "get /me/documents": "documents:read",
  "get /me/profile": "profile:read",
  "patch /me/profile": "profile:write",
  "get /me/key": null,
};

export function buildOpenApiSpec() {
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  return withAccessControl({
    openapi: "3.1.0",
    info: {
      title: "Recruvault API",
      version: "1.0.0",
      description:
        "Programmatic access for recruiters and job seekers. Keys are bearer tokens with explicit scopes and an expiry. A key cannot exceed the caller's live role, and a locked vault cannot be bypassed. Organisation keys manage roles and candidate workflows; job-seeker keys access only the owner's applications, career-document metadata, and discovery profile. Each operation lists its required scope in `x-required-scopes`. 401 means the key is invalid, expired, revoked, or must be replaced; 403 means a valid key lacks the scope or role, or the vault is not enrolled. Requests share per-key, per-user, per-organisation, per-IP, and per-route budgets across all instances; 429 responses carry `Retry-After` (seconds until the window resets).",
    },
    servers: [{ url: `${appUrl}/api/v1` }],
    tags: [
      { name: "Recruiter", description: "Organisation-scoped role and placement operations." },
      { name: "Job seeker", description: "Owner-scoped application and career-record operations." },
    ],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", bearerFormat: "rv_ token" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } } },
        RateLimited: {
          type: "object",
          properties: { error: { type: "string" }, retryAfterSeconds: { type: "integer" } },
        },
        KeyDescription: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["organisation", "candidate"] },
            name: { type: "string" },
            prefix: { type: "string", example: "rv_1a2b3c4d" },
            scopes: { type: "array", items: { type: "string" } },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            role: { type: "string", description: "Organisation keys: the creator's current role." },
          },
        },
        CreateRequest: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", example: "Senior Systems Engineer, NV1" },
            description: { type: "string", nullable: true },
            location: { type: "string", nullable: true, example: "Canberra, ACT" },
            employmentType: {
              type: "string",
              nullable: true,
              enum: ["permanent", "contract", "fixed_term", "casual", null],
            },
            workArrangement: {
              type: "string",
              nullable: true,
              enum: ["on_site", "hybrid", "remote", null],
            },
            salaryMin: { type: "integer", minimum: 0, nullable: true },
            salaryMax: { type: "integer", minimum: 0, nullable: true },
            salaryPeriod: {
              type: "string",
              nullable: true,
              enum: ["annual", "daily", "hourly", null],
            },
            skills: {
              type: "array",
              maxItems: 30,
              items: { type: "string", maxLength: 80 },
              description:
                "Role search metadata used for opt-in matching alerts; it is not a candidate response field.",
            },
            consentPurpose: { type: "string", nullable: true },
            listed: { type: "boolean", default: false },
            jdViewMode: { type: "string", enum: ["view_only", "allow_download"] },
            expiresAt: { type: "string", format: "date-time", nullable: true },
            fieldKeys: {
              type: "array",
              items: {
                type: "string",
                enum: ["clearance_level", "clearance_id", "resume", "cover_letter"],
              },
              description: "Candidate requirements for the role.",
            },
            includeDefaults: {
              type: "boolean",
              default: true,
              description: "Append resume + cover_letter if not present.",
            },
          },
        },
        MatchRequest: {
          type: "object",
          properties: {
            clearanceLevel: { type: "string", enum: ["baseline", "nv1", "nv2", "pv", "tspa"] },
            skills: { type: "array", items: { type: "string" } },
            limit: { type: "integer", default: 20, maximum: 50 },
          },
        },
        CandidateProfileUpdate: {
          type: "object",
          properties: {
            discoverable: { type: "boolean" },
            clearanceLevel: {
              type: ["string", "null"],
              enum: ["baseline", "nv1", "nv2", "pv", "tspa", null],
            },
            skills: { type: "array", items: { type: "string" }, maxItems: 30 },
            location: { type: ["string", "null"], maxLength: 120 },
          },
          description:
            "Identity documents, citizenship, right-to-work information, and police checks are not accepted.",
        },
        CandidateMatch: {
          type: "object",
          properties: {
            handle: { type: "string", example: "cand_1a2b3c4d5e" },
            score: { type: "number", example: 1 },
            matched: { type: "array", items: { type: "string" } },
            clearanceLevel: { type: "string", nullable: true },
            location: { type: "string", nullable: true },
            skills: { type: "array", items: { type: "string" } },
          },
        },
        SendRequest: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            candidateHandle: { type: "string", description: "Opaque handle from /match." },
          },
        },
      },
    },
    paths: {
      "/me/key": {
        get: {
          tags: ["Recruiter", "Job seeker"],
          summary: "Describe the presented API key",
          description:
            "Returns the key's kind, scopes, and expiry so clients can offer only permitted operations. Never returns key material.",
          responses: {
            "200": { description: "OK", content: json({ key: ref("KeyDescription") }) },
          },
        },
      },
      "/requests": {
        get: {
          tags: ["Recruiter"],
          summary: "List requests",
          responses: { "200": { description: "OK" }, "401": errRef() },
        },
        post: {
          tags: ["Recruiter"],
          summary: "Create a request",
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateRequest") } },
          },
          responses: {
            "201": { description: "Created", content: json({ id: { type: "string" } }) },
            "400": errRef(),
            "401": errRef(),
          },
        },
      },
      "/requests/{id}": {
        get: {
          tags: ["Recruiter"],
          summary: "Get a request with its fields",
          parameters: [idParam()],
          responses: { "200": { description: "OK" }, "404": errRef() },
        },
      },
      "/requests/{id}/jd": {
        post: {
          tags: ["Recruiter"],
          summary: "Upload the job description (PDF or Word .docx)",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { jd: { type: "string", format: "binary" } },
                  required: ["jd"],
                },
              },
            },
          },
          responses: { "200": { description: "Uploaded" }, "400": errRef(), "404": errRef() },
        },
      },
      "/requests/{id}/submissions": {
        get: {
          tags: ["Recruiter"],
          summary: "List submission metadata for a request",
          parameters: [idParam()],
          responses: { "200": { description: "OK" }, "403": errRef(), "404": errRef() },
        },
      },
      "/requests/{id}/send": {
        post: {
          tags: ["Recruiter"],
          summary: "Send the secure link to an email or a candidate handle",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("SendRequest") } },
          },
          responses: { "200": { description: "Queued" }, "400": errRef(), "404": errRef() },
        },
      },
      "/reports/recruiter": {
        get: {
          tags: ["Recruiter"],
          summary: "Get recruiter operations report",
          description:
            "Returns active and unfilled roles, previous-calendar-month application activity, unanswered invitations, stage aging, application velocity, matched-alert performance, role-level pipeline stages, deadlines, and a prioritised action queue.",
          responses: {
            "200": { description: "Detailed recruiter caseload and priority report" },
            "401": errRef(),
            "403": errRef(),
          },
        },
      },
      "/match": {
        post: {
          tags: ["Recruiter"],
          summary: "Find opted-in candidates matching role requirements",
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("MatchRequest") } },
          },
          responses: {
            "200": {
              description: "OK",
              content: json({
                matches: { type: "array", items: ref("CandidateMatch") },
              }),
            },
            "401": errRef(),
          },
        },
      },
      "/me/applications": {
        get: {
          tags: ["Job seeker"],
          summary: "List my applications",
          description: "Returns only applications owned by the authenticated job seeker.",
          responses: { "200": { description: "OK" }, "401": errRef() },
        },
      },
      "/me/documents": {
        get: {
          tags: ["Job seeker"],
          summary: "List my career documents",
          description: "Returns scan state and metadata for resumes and cover letters. It never returns file bytes.",
          responses: { "200": { description: "OK" }, "401": errRef() },
        },
      },
      "/me/profile": {
        get: {
          tags: ["Job seeker"],
          summary: "Get my discovery profile",
          responses: { "200": { description: "OK" }, "401": errRef() },
        },
        patch: {
          tags: ["Job seeker"],
          summary: "Update my discovery profile",
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CandidateProfileUpdate") } },
          },
          responses: { "200": { description: "Updated" }, "400": errRef(), "401": errRef() },
        },
      },
    },
  });
}

type Operation = {
  responses: Record<string, unknown>;
  security?: unknown;
  "x-required-scopes"?: string[];
};

/** Attach required scopes and the shared 401/403/429 responses to every operation. */
function withAccessControl<T extends { paths: Record<string, Record<string, Operation>> }>(spec: T): T {
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const scope = OPERATION_SCOPES[`${method} ${path}`];
      operation["x-required-scopes"] = scope ? [scope] : [];
      // OpenAPI 3.1 allows role names for non-OAuth schemes.
      operation.security = [{ apiKey: scope ? [scope] : [] }];
      operation.responses["401"] ??= errRef("Invalid, expired, revoked, or legacy key");
      operation.responses["403"] ??= errRef("Missing scope, role, verification, or vault enrollment");
      operation.responses["429"] ??= {
        description: "Request budget exhausted",
        headers: {
          "Retry-After": {
            description: "Seconds until the exhausted window resets.",
            schema: { type: "integer" },
          },
        },
        content: { "application/json": { schema: ref("RateLimited") } },
      };
    }
  }
  return spec;
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}
function errRef(description = "Error") {
  return { description, content: { "application/json": { schema: ref("Error") } } };
}
function idParam() {
  return { name: "id", in: "path", required: true, schema: { type: "string" } };
}
function json(properties: Record<string, unknown>) {
  return { "application/json": { schema: { type: "object", properties } } };
}
