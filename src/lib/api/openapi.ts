/**
 * Hand-authored OpenAPI 3.1 document for the Recruvault v1 REST API. Kept as a
 * plain object (no build-time generation) so it stays dependency-light and is
 * served verbatim at /api/v1/openapi.json.
 */
export function buildOpenApiSpec() {
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  return {
    openapi: "3.1.0",
    info: {
      title: "Recruvault API",
      version: "1.0.0",
      description:
        "Programmatic access for recruiters: create secure requests, upload job descriptions, match opted-in candidates, and send secure links. Authenticate with an API key (Settings → API keys) as a Bearer token.",
    },
    servers: [{ url: `${appUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", bearerFormat: "rv_ token" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } } },
        CreateRequest: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", example: "Senior Systems Engineer — NV1" },
            description: { type: "string", nullable: true },
            consentPurpose: { type: "string", nullable: true },
            listed: { type: "boolean", default: false },
            jdViewMode: { type: "string", enum: ["view_only", "allow_download"] },
            expiresAt: { type: "string", format: "date-time", nullable: true },
            fieldKeys: {
              type: "array",
              items: { type: "string" },
              description: "Field-library keys to request, e.g. clearance_level, citizenship.",
            },
            customLabels: { type: "array", items: { type: "string" } },
            includeDefaults: {
              type: "boolean",
              default: true,
              description: "Append resume + suitability_statement if not present.",
            },
          },
        },
        MatchRequest: {
          type: "object",
          properties: {
            clearanceLevel: { type: "string", enum: ["baseline", "nv1", "nv2", "pv", "tspa"] },
            citizenship: { type: "string" },
            rightToWork: { type: "string" },
            skills: { type: "array", items: { type: "string" } },
            limit: { type: "integer", default: 20, maximum: 50 },
          },
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
      "/requests": {
        get: {
          summary: "List requests",
          responses: { "200": { description: "OK" }, "401": errRef() },
        },
        post: {
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
          summary: "Get a request with its fields",
          parameters: [idParam()],
          responses: { "200": { description: "OK" }, "404": errRef() },
        },
      },
      "/requests/{id}/jd": {
        post: {
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
          summary: "List submission metadata for a request",
          parameters: [idParam()],
          responses: { "200": { description: "OK" }, "403": errRef(), "404": errRef() },
        },
      },
      "/requests/{id}/send": {
        post: {
          summary: "Send the secure link to an email or a candidate handle",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("SendRequest") } },
          },
          responses: { "200": { description: "Queued" }, "400": errRef(), "404": errRef() },
        },
      },
      "/match": {
        post: {
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
    },
  };
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}
function errRef() {
  return { description: "Error", content: { "application/json": { schema: ref("Error") } } };
}
function idParam() {
  return { name: "id", in: "path", required: true, schema: { type: "string" } };
}
function json(properties: Record<string, unknown>) {
  return { "application/json": { schema: { type: "object", properties } } };
}
