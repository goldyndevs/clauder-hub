import { CHANNEL_KINDS, INTERACTION_KINDS, listChannels } from "./channels/index.js";
import { listCategories } from "./categories.js";
import { currentProject, isGlobal } from "./context.js";
import { MCP_CATALOG, catalogEntry, type CatalogEntry } from "./mcpCatalog.js";
import { getJob } from "./jobs.js";
import { getPreset } from "./toolset.js";

/**
 * The hub has no forms: creating or changing a job, a run, a category, a
 * preset or a channel opens a Claude session for that one purpose. The same
 * note (what it is for, every parameter, samples, the API to call) is shown
 * highlighted at the top of the session in the dashboard and appended to the
 * session's system prompt, so the person and Claude read the same thing.
 *
 * Claude writes through the hub's local API with curl, after showing the
 * final JSON and getting a yes. The session stays open afterwards for more
 * edits; the person closes it.
 */
export type PurposeKind =
  | "hub"
  | "create-job"
  | "edit-job"
  | "queue-run"
  | "create-category"
  | "edit-category"
  | "create-preset"
  | "edit-preset"
  | "create-channel"
  | "edit-channel"
  | "add-mcp";

const KINDS: PurposeKind[] = ["hub", "create-job", "edit-job", "queue-run", "create-category", "edit-category", "create-preset", "edit-preset", "create-channel", "edit-channel", "add-mcp"];

/** An MCP server to add: a catalog entry when the page named one, otherwise whatever the person asks for. */
function addMcpDefinition(entry: CatalogEntry | null): Definition {
  const api = [
    "GET /api/inventory: the servers already configured (field mcpServers)",
    'POST /api/mcp/install with { "command": "claude mcp add ...", "scope": "project" | "local" }: runs it. Only `claude mcp add` is accepted, at project scope (the repo\'s .mcp.json) or local scope (this machine only).',
  ];
  const scopeNote = "A server that carries a token or key goes in at local scope, so the secret never lands in the repository's .mcp.json; otherwise project scope, shared with the repo.";
  const loadNote = "MCP servers load when a session starts: say the person can use it from a new session (or by resuming one).";
  // Claude Code's own docs: native Windows cannot start npx directly for a stdio server.
  const windowsNote = process.platform === "win32" ? ["This machine runs Windows: a stdio server started with npx needs `cmd /c` in front, e.g. `-- cmd /c npx -y <package>`."] : [];
  if (!entry) {
    return {
      title: "Add an MCP server",
      summary: `Adds an MCP server to this project. Ask which one; for a well-known server use the command from its catalog entry (${MCP_CATALOG.map((item) => item.id).join(", ")}), and for any other find its official docs and build the command from them.`,
      params: [],
      samples: MCP_CATALOG.slice(0, 2).map((item) => ({ server: item.name, command: item.addCommand })),
      api,
      notes: [scopeNote, loadNote, ...windowsNote],
    };
  }
  const secret = entry.params.some((param) => param.secret);
  return {
    title: `Add the ${entry.name} MCP server`,
    summary: `${entry.description} A ${entry.transport} server by ${entry.vendor}.${
      entry.auth === "oauth" ? " It signs in through the browser: once added, the person runs /mcp in a new session and picks it to log in." : ""
    }${entry.params.length ? " Ask the person for the values below, then put them into the command." : " Nothing has to be supplied: confirm, then add it."}`,
    params: entry.params.map((param) => ({
      name: param.key,
      type: `${param.kind}${param.secret ? ", secret" : ""}`,
      required: param.required,
      description: `${param.name}: ${param.description}`,
      example: param.example,
    })),
    samples: [{ command: entry.addCommand, scope: secret ? "local" : "project" }],
    api,
    notes: [`Source: ${entry.docs}`, scopeNote, loadNote, ...(entry.transport === "stdio" ? windowsNote : []), ...(secret ? ["Never repeat a token back in your messages once it is given."] : [])],
  };
}

export interface Purpose {
  kind: PurposeKind;
  targetId?: string;
}

interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example: string;
}

interface Definition {
  title: string;
  summary: string;
  params: Param[];
  samples: unknown[];
  api: string[];
  notes?: string[];
}

const JOB_PARAMS: Param[] = [
  { name: "name", type: "string", required: true, description: "Shown in the dashboard and as the session name of each run.", example: "Triage Jira bugs" },
  { name: "kind", type: '"cron" | "webhook"', required: true, description: "cron runs on a schedule; webhook runs when something POSTs to its URL.", example: "cron" },
  { name: "schedule", type: "string (cron)", required: false, description: "Required for cron. 5 fields (or 6 with seconds), this machine's time zone.", example: "0 9 * * 1-5" },
  {
    name: "prompt",
    type: "string",
    required: true,
    description: "What each run's session is asked to do. {{now}} is the time it fired; for webhooks {{payload}} is the body as JSON and {{payload.field}} one value.",
    example: "Fix the bug in {{payload.issue}} and open a PR.",
  },
  { name: "category", type: "string", required: false, description: '"auto" (Claude picks) or a task category name; decides what the run must deliver before it closes. Default "auto".', example: "bugfix" },
  { name: "presetId", type: "string | null", required: false, description: "Toolset preset id from GET /api/presets; null uses the default preset.", example: "null" },
  { name: "enabled", type: "boolean", required: false, description: "Default true.", example: "true" },
];

const CATEGORY_PARAMS: Param[] = [
  { name: "name", type: "string", required: true, description: 'Unique; "auto" is reserved.', example: "bugfix" },
  { name: "description", type: "string", required: false, description: "What kind of task it is.", example: "A defect fixed" },
  {
    name: "deliverables",
    type: "Array<{ name, description, required }>",
    required: false,
    description: "What a session must report before it may close. required defaults to true.",
    example: '[{ "name": "PR", "description": "link to the pull request", "required": true }]',
  },
];

const PRESET_PARAMS: Param[] = [
  { name: "name", type: "string", required: true, description: "Shown in job settings and the session Toolset tab.", example: "Frontend only" },
  { name: "isDefault", type: "boolean", required: false, description: "The default preset is used by new sessions and by jobs without one. Only one can be default.", example: "false" },
  {
    name: "toolset",
    type: "{ agents: string[], skills: string[], mcp: string[], plugins: string[] }",
    required: true,
    description: "What is turned OFF; everything else stays on. Ids come from GET /api/toolset/catalog (field kind tells which list, field id is the value).",
    example: '{ "agents": ["Explore"], "skills": [], "mcp": ["mcp__plugin_figma_figma"], "plugins": [] }',
  },
];

function channelParams(): Param[] {
  const fields = CHANNEL_KINDS.map(
    (kind) => `${kind.kind}: ${kind.fields.map((field) => `${field.key}${field.secret ? " (secret)" : ""}${field.options ? ` [${field.options.join("|")}]` : ""}${field.hint ? ` - ${field.hint}` : ""}`).join("; ")}`,
  ).join(" || ");
  return [
    { name: "kind", type: `"${CHANNEL_KINDS.map((kind) => kind.kind).join('" | "')}"`, required: true, description: "The platform. Cannot change after creation.", example: "slack" },
    { name: "name", type: "string", required: true, description: "Shown in the dashboard.", example: "Team Slack" },
    { name: "enabled", type: "boolean", required: false, description: "Default true.", example: "true" },
    { name: "kinds", type: "string[]", required: false, description: `What it is sent; any of ${INTERACTION_KINDS.join(", ")}. Default all.`, example: '["permission", "question", "done"]' },
    { name: "config", type: "object", required: true, description: `Per platform. ${fields}`, example: '{ "botToken": "xoxb-...", "appToken": "xapp-...", "channel": "C0123456789" }' },
  ];
}

const curlNote = (hub: string) =>
  `Call the API with curl from Bash, sending JSON from a heredoc so quoting cannot break it, e.g.\ncurl -s -X POST ${hub}/api/jobs -H "content-type: application/json" --data-binary @- <<'JSON'\n{ ... }\nJSON`;

/** The general hub task covers each of these, its note gathering theirs. */
const HUB_SECTIONS: Array<{ heading: string; purpose: Purpose }> = [
  { heading: "Jobs", purpose: { kind: "create-job" } },
  { heading: "Runs (the queue)", purpose: { kind: "queue-run" } },
  { heading: "Task categories", purpose: { kind: "create-category" } },
  { heading: "Toolset presets", purpose: { kind: "create-preset" } },
  { heading: "Channels", purpose: { kind: "create-channel" } },
];

function definitionOf(purpose: Purpose): Definition {
  switch (purpose.kind) {
    case "add-mcp":
      return addMcpDefinition(catalogEntry(purpose.targetId));
    case "hub":
      return {
        title: "Hub task",
        summary:
          "A general configuration session: jobs, the run queue, task categories, toolset presets and channels, whichever the person asks about, several at once if they like. Each kind is described below.",
        params: [],
        samples: [],
        api: [
          "Reading: GET /api/jobs, /api/runs, /api/categories, /api/presets, /api/channels, /api/toolset/catalog",
          "Writing: as each section below says, plus DELETE /api/jobs/<id>, /api/categories/<id>, /api/presets/<id>, /api/channels/<id>",
          "Other actions: POST /api/jobs/<id>/run (queue a job now), POST /api/runs/<id>/cancel (drop a queued run), POST /api/channels/<id>/test",
        ],
        notes: ["A delete is confirmed like any write: name exactly what goes, then ask."],
      };
    case "create-job":
    case "edit-job":
      return {
        title: purpose.kind === "create-job" ? "Create a job" : "Edit a job",
        summary: "A job starts an unattended Claude session in this project on a cron schedule or when its webhook is called. Runs go through one queue, one at a time, with permission mode \"default\"; their questions reach the person's channels.",
        params: JOB_PARAMS,
        samples: [
          { name: "Triage Jira bugs", kind: "cron", schedule: "0 9 * * 1-5", prompt: "Look up the Jira bugs assigned to the team that were created since yesterday. For each one you can reproduce, fix it on its own branch and open a PR.", category: "bugfix", presetId: null, enabled: true },
          { name: "Fix reported issue", kind: "webhook", prompt: "Issue {{payload.issue}} was reported: {{payload.summary}}. Reproduce it, fix it and open a PR.", category: "auto", presetId: null, enabled: true },
        ],
        api: [
          "GET /api/jobs (all jobs), GET /api/categories, GET /api/presets",
          purpose.kind === "create-job" ? "POST /api/jobs with the job JSON" : `PUT /api/jobs/${purpose.targetId} with the full job JSON (all fields, changed or not)`,
          "A webhook job's answer carries id and token: it is triggered with POST /api/trigger/<id> and the header x-clauder-token: <token>.",
        ],
      };
    case "queue-run":
      return {
        title: "Queue a run",
        summary: "A run is one unattended session, started after whatever is already queued. It is closed when it reports its task done with the category's deliverables.",
        params: [
          { name: "prompt", type: "string", required: true, description: "What the session is asked to do, complete enough to work without anyone at the keyboard.", example: "Upgrade the date library to the latest minor version and fix what breaks." },
          { name: "category", type: "string", required: false, description: '"auto" or a task category name. Default "auto".', example: "feature" },
        ],
        samples: [{ prompt: "Add input validation to the signup form and cover it with tests.", category: "feature" }],
        api: ["GET /api/categories, GET /api/runs (the queue)", "POST /api/runs with { prompt, category }"],
      };
    case "create-category":
    case "edit-category":
      return {
        title: purpose.kind === "create-category" ? "Create a task category" : "Edit a task category",
        summary: "A category says what \"done\" means for a kind of task: the deliverables a session must report before the hub closes it.",
        params: CATEGORY_PARAMS,
        samples: [
          {
            name: "bugfix",
            description: "A defect fixed",
            deliverables: [
              { name: "PR", description: "link to the pull request", required: true },
              { name: "RCA", description: "root cause analysis, a few sentences or a file path", required: true },
              { name: "Test evidence", description: "the failing case now passing", required: true },
            ],
          },
        ],
        api: ["GET /api/categories", purpose.kind === "create-category" ? "POST /api/categories" : `PUT /api/categories/${purpose.targetId} with the full category`],
      };
    case "create-preset":
    case "edit-preset":
      return {
        title: purpose.kind === "create-preset" ? "Create a toolset preset" : "Edit a toolset preset",
        summary: "A preset names what to turn off (agents, skills, MCP servers, plugins) for the sessions that use it. It applies at session start-up.",
        params: PRESET_PARAMS,
        samples: [{ name: "No design tools", isDefault: false, toolset: { agents: [], skills: [], mcp: ["mcp__plugin_figma_figma"], plugins: ["figma@claude-plugins-official"] } }],
        api: ["GET /api/toolset/catalog (every id that can be turned off), GET /api/presets", purpose.kind === "create-preset" ? "POST /api/presets" : `PUT /api/presets/${purpose.targetId} with the full preset`],
        notes: ["Turning a plugin off takes its skills, agents and MCP servers with it. MCP servers and plugin skills turned off are blocked, not hidden."],
      };
    case "create-channel":
    case "edit-channel":
      return {
        title: purpose.kind === "create-channel" ? "Add a channel" : "Edit a channel",
        summary: isGlobal(currentProject())
          ? "A global channel serves every project in the hub: their permission requests, questions, ends of turns, MCP suggestions and finished tasks all arrive on it, each named after its project, and replies go back into the right session. A bot used here cannot also be a project's own channel."
          : "A channel is where sessions reach the person: permission requests, questions, ends of turns, MCP suggestions and finished tasks. Replies there go back into the session.",
        params: channelParams(),
        samples: [
          { kind: "slack", name: "Team Slack", enabled: true, kinds: ["permission", "question", "turn", "mcp", "done"], config: { botToken: "xoxb-...", appToken: "xapp-...", channel: "C0123456789" } },
          { kind: "telegram", name: "My phone", enabled: true, kinds: ["permission", "question", "done"], config: { botToken: "123456:ABC-...", chatId: "123456789" } },
        ],
        api: [
          "GET /api/channels (kinds and fields, existing channels with secrets masked as ********)",
          purpose.kind === "create-channel" ? "POST /api/channels" : `PUT /api/channels/${purpose.targetId} with the full channel; send ******** back for a secret to keep it unchanged`,
          "POST /api/channels/<id>/test sends a test message.",
        ],
        notes: ["Never repeat a token back in your messages once it is given."],
      };
  }
}

/** The item an edit purpose is about, as it stands, secrets masked. */
function currentValue(purpose: Purpose): unknown {
  if (!purpose.targetId) return undefined;
  switch (purpose.kind) {
    case "edit-job": {
      const job = getJob(purpose.targetId);
      return job && { name: job.name, kind: job.kind, schedule: job.schedule, prompt: job.prompt, category: job.category, presetId: job.presetId, enabled: job.enabled };
    }
    case "edit-category": {
      const category = listCategories().find((item) => item.id === purpose.targetId);
      return category && { name: category.name, description: category.description, deliverables: category.deliverables };
    }
    case "edit-preset": {
      const preset = getPreset(purpose.targetId);
      return preset && { name: preset.name, isDefault: preset.isDefault, toolset: preset.toolset };
    }
    case "edit-channel": {
      const channel = listChannels().find((item) => item.id === purpose.targetId);
      return channel && { kind: channel.kind, name: channel.name, enabled: channel.enabled, kinds: channel.kinds, config: channel.config };
    }
    default:
      return undefined;
  }
}

export function purposeTitle(purpose: Purpose): string {
  return definitionOf(purpose).title;
}

export function isPurpose(value: unknown): value is Purpose {
  return KINDS.includes((value as Purpose)?.kind);
}

/** One definition's parameters, current value, samples, API and notes, under headings of the given depth. */
function sectionLines(definition: Definition, current: unknown, depth: string): string[] {
  const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  if (definition.params.length) {
    lines.push(
      `${depth} Parameters`,
      "",
      "| Name | Type | Required | Description | Example |",
      "| --- | --- | --- | --- | --- |",
      ...definition.params.map((param) => `| \`${param.name}\` | ${escapeCell(param.type)} | ${param.required ? "yes" : "no"} | ${escapeCell(scopeApi(param.description))} | \`${escapeCell(param.example)}\` |`),
      "",
    );
  }
  if (current !== undefined) lines.push(`${depth} Current value`, "", "```json", JSON.stringify(current, null, 2), "```", "");
  if (definition.samples.length) {
    lines.push(`${depth} Samples`, "");
    for (const sample of definition.samples) lines.push("```json", JSON.stringify(sample, null, 2), "```", "");
  }
  lines.push(`${depth} API`, "", ...definition.api.map((item) => `- ${scopeApi(item)}`), "");
  if (definition.notes?.length) lines.push(`${depth} Notes`, "", ...definition.notes.map((item) => `- ${scopeApi(item)}`), "");
  return lines;
}

/**
 * The API paths the hub's own text names are written /api/...; the session's
 * project puts its id in them. Only that text: a current value or a sample is
 * the person's data (a webhook URL may well hold "/api/") and stays as it is.
 */
function scopeApi(text: string): string {
  return text.replace(/\/api\/(?!p\/)/g, `/api/p/${currentProject().id}/`);
}

/** The note, as markdown: shown at the top of the session and appended to its system prompt. */
export function purposeNote(purpose: Purpose, hub: string): string {
  const definition = definitionOf(purpose);
  const lines = [`# Purpose: ${definition.title}`, "", scopeApi(definition.summary), "", `The hub runs at ${hub}.`, ""];
  lines.push(...sectionLines(definition, currentValue(purpose), "##"));
  // The general hub task carries every kind's own section, one level down.
  if (purpose.kind === "hub") {
    for (const section of HUB_SECTIONS) {
      const inner = definitionOf(section.purpose);
      lines.push(`## ${section.heading}`, "", scopeApi(inner.summary), "", ...sectionLines(inner, undefined, "###"));
    }
  }
  return lines.join("\n");
}

/** What Claude is told on top of the note: how to work in a purpose session. */
export function purposeSystemPrompt(purpose: Purpose, hub: string): string {
  return [
    "# This is a Clauder Hub configuration session",
    "",
    purpose.kind === "hub"
      ? "This session configures the hub, whatever part of it the person asks about. Do not change the project's code or files; work only through the hub's API."
      : "This session exists for one purpose, described below. Do not change the project's code or files; work only through the hub's API.",
    "",
    "1. Ask for what is missing, a few things at a time, using AskUserQuestion when the answer is a choice. Offer sensible defaults.",
    "2. Read what you need first (existing items, categories, presets, the toolset catalog) so names and ids are real.",
    "3. Before any POST, PUT or DELETE, show exactly what will change (the final JSON, or what goes) and ask the person to confirm with AskUserQuestion (Save / Change something). Write only after a yes.",
    "4. If the API answers with an error, explain it in one line, fix the JSON and ask again.",
    "5. After saving, say what was saved in one or two lines. The session stays open: the person may ask for more changes, so keep helping until they close it.",
    "",
    scopeApi(curlNote(hub)),
    "",
    purposeNote(purpose, hub),
  ].join("\n");
}
