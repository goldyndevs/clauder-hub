/**
 * Well-known MCP servers the MCP servers page recommends. Adding one opens an
 * "add-mcp" hub task whose note carries the entry: what the person must
 * supply (nothing, for a server that signs in with OAuth) and the command.
 * Commands and URLs come from each server's own docs (see `docs`); they move,
 * so an entry is data to keep current, not code.
 */
export interface CatalogParam {
  /** What to call it when asking. */
  name: string;
  kind: "env" | "header" | "arg";
  /** The env var, header or argument it fills. */
  key: string;
  required: boolean;
  /** A token or key: the server then belongs at local scope, out of the repo. */
  secret: boolean;
  description: string;
  example: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  vendor: string;
  category: "issues" | "docs" | "mail" | "chat" | "code" | "design" | "monitoring" | "browser" | "data" | "other";
  description: string;
  transport: "http" | "sse" | "stdio";
  /** For http/sse: whether it signs in through the browser after adding (/mcp in a session). */
  auth?: "oauth" | "header" | "none";
  params: CatalogParam[];
  /** The name it is added under, which `claude mcp list` and the inventory show. */
  serverName: string;
  /** A complete example, placeholders in angle brackets. */
  addCommand: string;
  docs: string;
}

// Checked against each vendor's docs on 2026-10-30. Commands carry no --scope: the hub sets it.
export const MCP_CATALOG: CatalogEntry[] = [
  {
    id: "atlassian",
    name: "Jira & Confluence",
    vendor: "Atlassian",
    category: "issues",
    description: "Search, read, create and update Jira issues and Confluence pages.",
    transport: "http",
    auth: "oauth",
    params: [],
    serverName: "atlassian",
    addCommand: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp",
    docs: "https://github.com/atlassian/atlassian-mcp-server",
  },
  {
    id: "trello",
    name: "Trello",
    vendor: "Atlassian",
    category: "issues",
    description: "Work with Trello boards, lists, cards and checklists.",
    transport: "http",
    auth: "oauth",
    params: [],
    serverName: "trello",
    addCommand: "claude mcp add --transport http trello https://mcp.trello.com/v1",
    docs: "https://github.com/atlassian/trello-mcp-server",
  },
  {
    id: "linear",
    name: "Linear",
    vendor: "Linear",
    category: "issues",
    description: "Find, create and update Linear issues, projects and comments.",
    transport: "http",
    auth: "oauth",
    params: [],
    serverName: "linear",
    addCommand: "claude mcp add --transport http linear https://mcp.linear.app/mcp",
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "azure-devops",
    name: "Azure DevOps",
    vendor: "Microsoft",
    category: "issues",
    description: "Query work items, repos, pull requests, pipelines and wikis.",
    transport: "http",
    auth: "oauth",
    params: [
      { name: "Organization", kind: "arg", key: "ORGANIZATION", required: true, secret: false, description: "The Azure DevOps organization, the last part of the URL. It must be backed by Microsoft Entra.", example: "contoso" },
      {
        name: "Entra app (client) ID",
        kind: "arg",
        key: "--client-id",
        required: true,
        secret: false,
        description: "An Entra app registration with redirect http://localhost:3118/callback, public client flows on, and delegated permission on 'Azure DevOps MCP' with admin consent.",
        example: "00000000-0000-0000-0000-000000000000",
      },
    ],
    serverName: "ado",
    addCommand: "claude mcp add --transport http ado https://mcp.dev.azure.com/<ORGANIZATION> --client-id <ENTRA_CLIENT_ID> --callback-port 3118",
    docs: "https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server",
  },
  {
    id: "github",
    name: "GitHub",
    vendor: "GitHub",
    category: "code",
    description: "Browse and manage repositories, issues and pull requests.",
    transport: "http",
    auth: "header",
    params: [
      { name: "Personal access token", kind: "header", key: "Authorization: Bearer", required: true, secret: true, description: "A GitHub PAT with the scopes the tools need (repo, read:org...).", example: "ghp_xxxxxxxxxxxxxxxxxxxx" },
    ],
    serverName: "github",
    addCommand: 'claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer <GITHUB_PAT>"',
    docs: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "outlook",
    name: "Outlook mail & calendar",
    vendor: "Softeria (community, Microsoft Graph)",
    category: "mail",
    description: "Read and send Outlook mail and manage calendar events through Microsoft Graph.",
    transport: "stdio",
    params: [
      { name: "Work or school account", kind: "arg", key: "--org-mode", required: false, secret: false, description: "Include it for a work or school (Microsoft 365) account; leave it out for personal Outlook.com.", example: "--org-mode" },
      { name: "Tool preset", kind: "arg", key: "--preset", required: false, secret: false, description: "Limit the tools: outlook (mail and calendar), mail, or calendar.", example: "outlook" },
    ],
    serverName: "ms365",
    addCommand: "claude mcp add ms365 -- npx -y @softeria/ms-365-mcp-server --org-mode --preset outlook",
    docs: "https://github.com/Softeria/ms-365-mcp-server",
  },
  {
    id: "notion",
    name: "Notion",
    vendor: "Notion",
    category: "docs",
    description: "Search, read and edit Notion pages and databases.",
    transport: "http",
    auth: "oauth",
    params: [],
    serverName: "notion",
    addCommand: "claude mcp add --transport http notion https://mcp.notion.com/mcp",
    docs: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "context7",
    name: "Context7",
    vendor: "Upstash",
    category: "docs",
    description: "Up-to-date, version-specific library docs and code examples.",
    transport: "http",
    auth: "header",
    params: [{ name: "API key", kind: "header", key: "Authorization: Bearer", required: true, secret: true, description: "An API key from context7.com.", example: "ctx7sk-xxxxxxxx" }],
    serverName: "context7",
    addCommand: 'claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "Authorization: Bearer <CONTEXT7_API_KEY>"',
    docs: "https://github.com/upstash/context7",
  },
  {
    id: "sentry",
    name: "Sentry",
    vendor: "Sentry",
    category: "monitoring",
    description: "Inspect Sentry issues, events and traces to debug production errors.",
    transport: "http",
    auth: "oauth",
    params: [
      { name: "Organization slug", kind: "arg", key: "ORG_SLUG", required: false, secret: false, description: "Scopes the server to one organization; leave out for all.", example: "my-org" },
      { name: "Project slug", kind: "arg", key: "PROJECT_SLUG", required: false, secret: false, description: "Scopes it further to one project, after the organization.", example: "my-project" },
    ],
    serverName: "sentry",
    addCommand: "claude mcp add --transport http sentry https://mcp.sentry.dev/mcp/<ORG_SLUG>/<PROJECT_SLUG>",
    docs: "https://mcp.sentry.dev/",
  },
  {
    id: "figma",
    name: "Figma",
    vendor: "Figma",
    category: "design",
    description: "Pull design context, variables and components from Figma files into code.",
    transport: "http",
    auth: "oauth",
    params: [],
    serverName: "figma",
    addCommand: "claude mcp add --transport http figma https://mcp.figma.com/mcp",
    docs: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
  },
  {
    id: "playwright",
    name: "Playwright",
    vendor: "Microsoft",
    category: "browser",
    description: "Drive a real browser: navigate, click, fill forms and snapshot pages.",
    transport: "stdio",
    params: [],
    serverName: "playwright",
    addCommand: "claude mcp add playwright -- npx @playwright/mcp@latest",
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "postgresql",
    name: "PostgreSQL",
    vendor: "Bytebase (DBHub)",
    category: "data",
    description: "Inspect schemas and run SQL queries against a PostgreSQL database.",
    transport: "stdio",
    params: [
      { name: "Connection string", kind: "arg", key: "--dsn", required: true, secret: true, description: "Preferably a read-only user; it contains the password.", example: "postgresql://readonly:pass@host:5432/dbname" },
    ],
    serverName: "db",
    addCommand: 'claude mcp add db -- npx -y @bytebase/dbhub --dsn "<POSTGRES_DSN>"',
    docs: "https://code.claude.com/docs/en/mcp",
  },
];

export function catalogEntry(id: string | undefined): CatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null;
}
