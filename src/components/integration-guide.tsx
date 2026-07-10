import { Bot, Braces, ExternalLink, KeyRound } from "lucide-react";
import { ApiKeysManager, type ApiKeyRow } from "@/components/api-keys-manager";
import { CopyAgentPrompt } from "@/components/copy-agent-prompt";
import {
  Badge,
  ButtonLink,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui";

type Audience = "recruiter" | "candidate";

const ENDPOINTS: Record<Audience, Array<{ method: string; path: string; detail: string }>> = {
  recruiter: [
    { method: "GET", path: "/requests", detail: "List organisation roles" },
    { method: "GET", path: "/reports/recruiter", detail: "Caseload and priority report" },
    { method: "POST", path: "/requests", detail: "Create a role" },
    { method: "POST", path: "/match", detail: "Find opted-in candidates" },
    { method: "POST", path: "/requests/{id}/send", detail: "Send a secure invitation" },
  ],
  candidate: [
    { method: "GET", path: "/me/applications", detail: "List your applications" },
    { method: "GET", path: "/me/documents", detail: "Check career-document scan state" },
    { method: "GET", path: "/me/profile", detail: "Read your discovery profile" },
    { method: "PATCH", path: "/me/profile", detail: "Update safe discovery fields" },
  ],
};

export function IntegrationGuide({
  audience,
  appUrl,
  keys,
}: {
  audience: Audience;
  appUrl: string;
  keys: ApiKeyRow[];
}) {
  const candidate = audience === "candidate";
  const accountLabel = candidate ? "job seeker" : "recruiter";
  const smokeTestTool = candidate ? "list_applications" : "list_requests";
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        recruvault: {
          command: "node",
          args: ["/absolute/path/to/Recruvault/mcp/index.mjs"],
          env: {
            RECRUVAULT_URL: appUrl,
            RECRUVAULT_API_KEY: "rv_your_key",
          },
        },
      },
    },
    null,
    2,
  );
  const agentPrompt = `Configure the Recruvault MCP server in my local MCP client.

Use the current Recruvault repository if it contains mcp/index.mjs. The server is a local stdio Node.js process.

Configuration:
- Server name: recruvault
- Command: node
- Server entry point: mcp/index.mjs, using its absolute path
- Recruvault URL: ${appUrl}
- Account type: ${accountLabel}
- Required environment variables: RECRUVAULT_URL and RECRUVAULT_API_KEY

Please:
1. Identify the MCP client and its configuration format.
2. Confirm the repository path and install the mcp package dependencies if needed.
3. Ask me for my Recruvault API key immediately before you add it to the configuration.
4. Add or update the MCP server configuration without changing unrelated servers.
5. Never print, log, or repeat the full API key in your response.
6. Verify that the server starts and list the tools available to my ${accountLabel} account.
7. Run a read-only smoke test with ${smokeTestTool}.
8. Tell me which configuration file you changed and whether the smoke test passed.

Do not create, update, send, revoke, or delete any Recruvault data while testing. If you cannot determine the MCP client or repository path safely, ask me before making changes.`;
  const usefulPrompts = candidate
    ? [
        "List my active applications, group them by stage, and tell me which ones need action from me.",
        "Review my application history and give me a concise follow-up plan for this week.",
        "Check my discovery profile and career-document status. Tell me what is complete and what I should improve.",
      ]
    : [
        "Use get_recruiter_report. How many job seekers are yet to provide requested information? Explain the definition, break the total down by role, and recommend the most useful follow-ups.",
        "Use get_recruiter_report. How many roles received applications during the previous calendar month and are still unfilled? State the exact date window, list each role with its application count and highest pipeline stage, and flag any delivery risk.",
        "Use get_recruiter_report to give me my main priorities for this week. Rank urgent deadlines, candidates needing review, offer-stage follow-ups, outstanding candidate information, and stale pipelines. Include concrete next actions.",
        "Give me a recruiter pipeline health report. Show active and unfilled roles, stage distribution, placements, offers awaiting an outcome, and the roles with the weakest recent application activity.",
        "Which roles are closing soon without a placed candidate? For each one, summarise the pipeline, outstanding information, and the next three actions I should take.",
        "Build my candidate action queue. Group received and follow-up applications by role, rank the roles by urgency, and distinguish recruiter actions from information still owed by job seekers.",
        "Where is my pipeline stalled? Compare average and oldest time in each current stage, identify candidates unchanged for more than seven days, and recommend an escalation order.",
        "Are matched role alerts working? Report sent, queued, failed, and skipped alerts, roles notified, and applications observed after an alert. Clearly distinguish association from proven attribution.",
        "Compare role velocity over the last 7 and 30 days. Rank active roles by applications per week, flag roles with no applications in 14 days, and suggest where sourcing effort should move.",
      ];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-medium text-accent">Developer access</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
          API &amp; MCP
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
          {candidate
            ? "Connect your own tools to review applications, check document status, and keep your discovery profile current. Your key cannot access another job seeker or a recruiter workspace."
            : "Connect internal systems and AI assistants to your placement workflow. Every request inherits your organisation role and remains tenant-scoped."}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  <Braces className="h-4 w-4 text-accent" aria-hidden />
                  REST API
                </CardTitle>
                <Badge>v1</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-sm leading-6 text-stone-600">
                Send your key as <code className="font-mono text-xs">Authorization: Bearer rv_…</code>.
                The base URL is <code className="font-mono text-xs">{appUrl}/api/v1</code>.
              </p>
              <div className="overflow-hidden rounded-md border border-stone-200">
                {ENDPOINTS[audience].map((endpoint) => (
                  <div
                    key={`${endpoint.method}-${endpoint.path}`}
                    className="grid gap-1 border-b border-stone-100 px-3 py-3 last:border-b-0 sm:grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
                  >
                    <span className="font-mono text-xs font-semibold text-accent">
                      {endpoint.method}
                    </span>
                    <code className="font-mono text-xs text-stone-800">{endpoint.path}</code>
                    <span className="text-xs text-stone-500">{endpoint.detail}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <ButtonLink href="/api/v1/docs" target="_blank" variant="secondary" size="sm">
                  Interactive API reference
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </ButtonLink>
                <ButtonLink
                  href="/api/v1/openapi.json"
                  target="_blank"
                  variant="ghost"
                  size="sm"
                >
                  OpenAPI JSON
                </ButtonLink>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-accent" aria-hidden />
                MCP setup
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-6 text-stone-600">
                Run the included stdio MCP server from a local Recruvault checkout. Add this
                configuration to Codex, Claude Code, or another MCP-compatible client.
              </p>
              <pre className="overflow-x-auto rounded-md border border-stone-200 bg-stone-950 p-4 text-xs leading-5 text-stone-100">
                <code>{mcpConfig}</code>
              </pre>
              <p className="text-xs leading-5 text-stone-500">
                {candidate
                  ? "Job-seeker tools: list_applications, list_career_documents, get_profile, and update_profile."
                  : "Recruiter tools: create_request, upload_jd, find_candidates, send_request, list_requests, get_submissions, and get_recruiter_report."}
              </p>
              <div className="space-y-3 border-t border-stone-200 pt-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900">
                      Let your agent configure it
                    </h3>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-stone-500">
                      Paste this into Codex, Claude Code, or another coding agent. It will ask for
                      your API key at the point it is needed.
                    </p>
                  </div>
                  <CopyAgentPrompt prompt={agentPrompt} />
                </div>
                <pre
                  aria-label="Agent setup prompt"
                  className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-stone-200 bg-stone-100/80 p-4 text-xs leading-5 text-stone-700"
                >
                  <code>{agentPrompt}</code>
                </pre>
              </div>

              <div className="space-y-3 border-t border-stone-200 pt-5">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900">
                    Useful prompts
                  </h3>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-stone-500">
                    {candidate
                      ? "Ask your assistant to turn your application data into a focused next-action list."
                      : "The operations report supplies the counts, date windows, role breakdowns, and priority evidence behind these answers."}
                  </p>
                </div>
                <div className="divide-y divide-stone-100 overflow-hidden rounded-md border border-stone-200 bg-white">
                  {usefulPrompts.map((prompt, index) => (
                    <div
                      key={prompt}
                      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="flex min-w-0 gap-3">
                        <span className="tnum mt-0.5 text-xs font-semibold text-stone-400">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <p className="text-sm leading-6 text-stone-700">{prompt}</p>
                      </div>
                      <CopyAgentPrompt
                        prompt={prompt}
                        label="Copy"
                        toastTitle="Prompt copied"
                        toastMessage="Paste it into your MCP-enabled assistant."
                      />
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-accent" aria-hidden />
                API keys
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ApiKeysManager keys={keys} scope={candidate ? "candidate" : "organisation"} />
            </CardContent>
          </Card>

          <div className="rounded-lg border border-stone-200 bg-stone-100/70 p-5">
            <h2 className="text-sm font-semibold text-stone-900">Access boundary</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              {candidate
                ? "A job-seeker key can read only your applications, resume and cover-letter metadata, and your safe discovery profile. It cannot download documents or access recruiter records."
                : "An organisation key carries the role of the member who created it. Recruiter permissions and tenant checks apply to every REST and MCP call."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
