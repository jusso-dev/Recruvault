# Recruvault MCP server

Lets recruiter and job-seeker AI agents (Claude Code, Codex, and other MCP
clients) work with Recruvault. Recruiters can manage role workflows. Job seekers
can review applications, inspect career-document status, and update their
discovery profile.

It talks only to the Recruvault **v1 REST API** over an API key, so it never
touches the database directly and inherits your role and org.

## Setup

1. In Recruvault, open **API & MCP** and create a key (starts with `rv_`). Copy
   it once; it is not shown again. Its permissions match the account that made it.
2. Install this package's dependencies:

   ```bash
   cd mcp && npm install
   ```

3. Configure the server with your URL and key.

### Claude Code

```bash
claude mcp add recruvault \
  --env RECRUVAULT_URL=http://localhost:3000 \
  --env RECRUVAULT_API_KEY=rv_your_key \
  -- node /absolute/path/to/mcp/index.mjs
```

### Codex / other MCP clients

Add to the client's MCP config:

```json
{
  "mcpServers": {
    "recruvault": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.mjs"],
      "env": {
        "RECRUVAULT_URL": "http://localhost:3000",
        "RECRUVAULT_API_KEY": "rv_your_key"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|------|--------------|
| `create_request` | Create a role (resume + cover letter/suitability statement added by default) |
| `upload_jd` | Attach a PDF or Word JD from a local file path |
| `find_candidates` | Match role requirements to opted-in seekers (opaque handles, no PII) |
| `send_request` | Send the secure link to an email or a candidate handle |
| `list_requests` | List your organisation's requests |
| `get_submissions` | List submission metadata for a request |
| `get_recruiter_report` | Report on unfilled roles, application trends, outstanding information, deadlines, and weekly priorities |
| `list_applications` | List the job seeker's own applications and stages |
| `list_career_documents` | List resume and cover-letter metadata and scan state |
| `get_profile` | Read the job seeker's discovery profile |
| `update_profile` | Update clearance, skills, location, and discoverability |

## Example flow

> "Upload ./jd-nv1-engineer.pdf as a new request titled 'Senior Systems Engineer,
> NV1', find NV1-cleared candidates with AWS and ISM skills, and send the link to
> the top matches."

The agent calls `create_request` → `upload_jd` → `find_candidates` → `send_request`.
Candidate identities are never exposed; the link is emailed to matched seekers
server-side.

A job seeker can ask: "Show my active applications and tell me whether my current
resume has completed security scanning." The agent uses `list_applications` and
`list_career_documents`, scoped to that job seeker's key.

Recruiter reporting examples:

- "How many job seekers are yet to provide requested information? Break it down by role and recommend follow-ups."
- "Which roles received applications during the previous calendar month and are still unfilled? State the exact date window and pipeline stage for each."
- "What are my main priorities this week? Rank deadlines, candidate reviews, stalled stages, offer follow-ups, outstanding information, and stale sourcing pipelines."
- "Where is my pipeline slowing down? Compare current-stage age and 7-day versus 30-day application velocity."
- "Are matched role alerts working? Report delivery outcomes and applications observed after an alert, without claiming causal attribution."

These use `get_recruiter_report`, which returns definitions alongside its counts so
an agent can explain exactly what each metric includes.

## Reference

Full API reference: `GET /api/v1/docs` (interactive) and `GET /api/v1/openapi.json`.
