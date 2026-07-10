# Recruvault MCP server

Lets a recruiter's AI agent (Claude Code, Codex) drive Recruvault: create secure
requests, upload job descriptions, find matching opted-in candidates, and send
secure links, without leaving the agent.

It talks only to the Recruvault **v1 REST API** over an API key, so it never
touches the database directly and inherits your role and org.

## Setup

1. In Recruvault, go to **Settings → API keys** and create a key (starts with
   `rv_`). Copy it once; it is not shown again.
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
| `create_request` | Create a request (resume + suitability added by default) |
| `upload_jd` | Attach a PDF or Word JD from a local file path |
| `find_candidates` | Match role requirements to opted-in seekers (opaque handles, no PII) |
| `send_request` | Send the secure link to an email or a candidate handle |
| `list_requests` | List your organisation's requests |
| `get_submissions` | List submission metadata for a request |

## Example flow

> "Upload ./jd-nv1-engineer.pdf as a new request titled 'Senior Systems Engineer — NV1',
> find NV1-cleared Australian citizens with AWS and ISM skills, and send the link to the
> top matches."

The agent calls `create_request` → `upload_jd` → `find_candidates` → `send_request`.
Candidate identities are never exposed; the link is emailed to matched seekers
server-side.

## Reference

Full API reference: `GET /api/v1/docs` (interactive) and `GET /api/v1/openapi.json`.
