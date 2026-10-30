import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteCategory, listCategories, saveCategory } from "./categories.js";
import { CHANNEL_KINDS, INTERACTION_KINDS, deleteChannel, httpReply, listChannels, mutedProjects, saveChannel, setMuted, testChannel } from "./channels/index.js";
import { checkClaudeCode, claudeStatus, findClaudeCode } from "./claudeCode.js";
import { iconFile, iconManifest } from "./fileIcons.js";
import { claudeSettings, EFFORTS, mcpSuggestionsEnabled, PERMISSION_MODES, saveClaudeSettings, setMcpSuggestionsEnabled } from "./claudeSettings.js";
import { subscribe } from "./events.js";
import { handleHook } from "./hooks.js";
import { AnswerError, answerInteraction, chooseInteraction, listInteractions, withPresentation } from "./interactions.js";
import { isDefinitionFile, isMemoryFile, memoryFiles, readInventory } from "./inventory.js";
import { cancelRun, deleteJob, enqueue, getJob, listJobs, listRuns, rotateToken, saveJob } from "./jobs.js";
import { catalogEntry, MCP_CATALOG } from "./mcpCatalog.js";
import { deleteSuggestion, installServer, installSuggestion, listSuggestions, skipSuggestion } from "./mcpSuggestions.js";
import { currentProject, withProject } from "./context.js";
import { projectRoot, runDir, toolVersion, transcriptsDir } from "./paths.js";
import { addProject, allProjects, getProject, listProjects, removeProject, touchProject } from "./projects.js";
import { promptDefinitions, renderPrompt, setPrompt } from "./prompts.js";
import { getSessionRow, hubUrl, listSessions, terminalByToken, normaliseSetup, restartSession, sessionSetup, sessionToolset, setSessionSetup, setSessionToolset, startSession, systemPromptFor } from "./sessions.js";
import { killTerminal, terminalForSession } from "./terminals.js";
import { isPurpose, purposeNote, purposeTitle } from "./purposes.js";
import { deleteSession, deletionPlan, setSessionTitle } from "./sessionFiles.js";
import { deletePreset, listPresets, normaliseToolset, savePreset, setDefaultItem, toolsetCatalog } from "./toolset.js";
import { listTranscripts, transcriptDetail, type Tokens } from "./transcripts.js";

/** One project's API, mounted at /api/p/<project id> with that project as the context (see index.ts). */
export const api = express.Router();
/** The hub's own: its projects, the live feed, and the endpoints Claude Code and other tools call without a project in the path. */
export const hubApi = express.Router();

/** Every handler may throw; the message goes back as JSON instead of an HTML page. */
const wrap =
  (handler: (req: express.Request, res: express.Response) => unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return;
      const status = error instanceof AnswerError ? 409 : 400;
      res.status(status).json({ error: (error as Error).message });
    }
  };

api.get(
  "/health",
  wrap(() => ({
    ok: true,
    version: toolVersion,
    projectId: currentProject().id,
    projectRoot: projectRoot(),
    project: currentProject().name,
    claude: findClaudeCode(),
    claudeStatus: claudeStatus(),
    transcriptsDir: transcriptsDir(),
  })),
);

// The hub ----------------------------------------------------------------

hubApi.get("/hub", wrap(() => ({ ok: true, version: toolVersion, claude: findClaudeCode(), claudeStatus: claudeStatus() })));

/** Claude Code looked at again: after installing it or signing in, without restarting the hub. */
hubApi.post("/claude/check", wrap(() => checkClaudeCode()));

/** Each project with what it is doing now, for the home page and the switcher. */
hubApi.get(
  "/projects",
  wrap(() =>
    listProjects().map((info) => {
      const project = getProject(info.id);
      // One project failing to read must not take the list, and the home page, down with it.
      let counts = { running: 0, waiting: 0 };
      if (project && info.exists) {
        try {
          counts = withProject(project, () => {
            const sessions = listSessions();
            return { running: sessions.filter((item) => item.live).length, waiting: sessions.filter((item) => item.status === "waiting").length };
          });
        } catch (error) {
          console.error(`[projects] ${info.name}:`, (error as Error).message);
        }
      }
      return { ...info, ...counts };
    }),
  ),
);
hubApi.post("/projects", wrap((req) => addProject(req.body?.path)));
hubApi.post("/projects/:id/open", wrap((req) => touchProject(req.params.id)));

// #/global: every project at once -------------------------------------------

/** Reads each running project in its own context; one that fails is skipped, not the whole answer. */
function acrossProjects<T>(read: (info: ReturnType<typeof listProjects>[number]) => T): T[] {
  const out: T[] = [];
  for (const info of listProjects()) {
    const project = getProject(info.id);
    if (!project || !info.exists) continue;
    try {
      out.push(withProject(project, () => read(info)));
    } catch (error) {
      console.error(`[global] ${info.name}:`, (error as Error).message);
    }
  }
  return out;
}

/** One card per project: its sessions, its queue, its next cron run, and the tokens of the sessions active today. */
hubApi.get(
  "/global/overview",
  wrap(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const muted = new Set(mutedProjects());
    return acrossProjects((info) => {
      const sessions = listSessions();
      const runs = listRuns(200);
      const next = listJobs()
        .filter((job) => job.enabled && job.nextRunAt)
        .map((job) => ({ name: job.name, at: job.nextRunAt! }))
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      const activeToday = sessions.filter((session) => session.lastAt && Date.parse(session.lastAt) >= today.getTime());
      // Cache reads left out: they repeat the context every turn and would dwarf what was actually sent and written.
      const tokens = activeToday.reduce((total, session) => total + (session.tokens ? session.tokens.input + session.tokens.output + session.tokens.cacheCreation : 0), 0);
      return {
        id: info.id,
        name: info.name,
        root: info.root,
        running: sessions.filter((session) => session.live).length,
        waiting: sessions.filter((session) => session.status === "waiting").length,
        queued: runs.filter((run) => run.status === "queued").length,
        runningRun: runs.find((run) => run.status === "running")?.jobName ?? (runs.some((run) => run.status === "running") ? "a run" : null),
        nextCron: next ?? null,
        activeToday: activeToday.length,
        tokensToday: tokens,
        muted: muted.has(info.id),
      };
    });
  }),
);

/** Everything waiting on a person, in every project, newest first; answered through each project's own API. */
hubApi.get(
  "/global/inbox",
  wrap(() =>
    acrossProjects((info) => withPresentation(listInteractions({ status: "open", limit: 100 })).map((item) => ({ ...item, project: { id: info.id, name: info.name } })))
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  ),
);

/** Whether the global channels hear from a project. */
hubApi.put("/global/muted/:id", wrap((req) => ({ muted: setMuted(req.params.id, req.body?.muted === true) })));
hubApi.delete("/projects/:id", wrap((req) => removeProject(req.params.id)));

/** Folders on the hub's machine, for the Open folder dialog; without a path, the home folder. */
hubApi.get(
  "/folders",
  wrap((req) => {
    const target = path.resolve(String(req.query.path || os.homedir()));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`${target} is not a folder.`);
    const folders = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(target, entry.name);
        return { name: entry.name, path: full, git: fs.existsSync(path.join(full, ".git")) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const parent = path.dirname(target);
    // Windows has no single root: its drives are the top.
    const drives = process.platform === "win32" ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => fs.existsSync(drive)) : ["/"];
    return { path: target, parent: parent === target ? null : parent, home: os.homedir(), drives, folders };
  }),
);

/** File and folder icons for the Files tab; the same for every project. */
hubApi.get("/file-icons/manifest", wrap(() => iconManifest()));
hubApi.get("/file-icons/:name.svg", (req, res) => {
  const file = iconFile(req.params.name);
  if (!file) return void res.status(404).end();
  // They change only with the package, so the browser keeps them.
  res.sendFile(file, { maxAge: "7d" });
});

hubApi.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const unsubscribe = subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Sessions ---------------------------------------------------------------

api.get("/sessions", wrap(() => listSessions()));

api.get(
  "/sessions/:id",
  wrap((req) => {
    const id = req.params.id;
    const view = listSessions().find((item) => item.id === id);
    if (!view) throw new Error("No such session.");
    const terminal = terminalForSession(id);
    const promptFile = terminal ? path.join(runDir, `${terminal.token}.prompt.md`) : null;
    return {
      session: view,
      detail: transcriptDetail(id),
      interactions: withPresentation(listInteractions({ sessionId: id, limit: 50 })),
      toolset: sessionToolset(id),
      setup: sessionSetup(id),
      // Built fresh each time, so an edit session shows the item as it stands now.
      purposeNote: view.purpose ? purposeNote(view.purpose, hubUrl()) : null,
      systemPrompt: promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : view.origin === "external" ? null : systemPromptFor(getSessionRow(id)?.category ?? null, view.purpose, sessionSetup(id)),
    };
  }),
);

api.post(
  "/sessions",
  wrap((req) => {
    const { prompt, category, name, permissionMode, cols, rows } = req.body ?? {};
    const terminal = startSession({ prompt, category: category || null, name: name || undefined, permissionMode: permissionMode || undefined, origin: "manual", cols, rows });
    return { sessionId: terminal.sessionId, terminalId: terminal.id };
  }),
);

/**
 * Every create and edit in the hub is a Claude session for that one purpose;
 * the person starts the conversation in its terminal.
 */
api.post(
  "/purpose-sessions",
  wrap((req) => {
    const { kind, targetId, cols, rows } = req.body ?? {};
    const purpose = { kind, ...(targetId ? { targetId: String(targetId) } : {}) };
    if (!isPurpose(purpose)) throw new Error("Unknown purpose.");
    if (kind.startsWith("edit-") && !purpose.targetId) throw new Error("Editing needs the id of what is edited.");
    // No first message, so the person says what they want; the purpose is in its system prompt. Adding an
    // MCP server is the exception: the click already said what, so Claude starts on it and asks for what it needs.
    const entry = kind === "add-mcp" ? catalogEntry(purpose.targetId) : null;
    const prompt = kind !== "add-mcp" ? undefined : entry ? renderPrompt("typed.addMcp", { server: entry.name }) : renderPrompt("typed.addAnyMcp", {});
    const terminal = startSession({ purpose, prompt, name: `Hub: ${purposeTitle(purpose)}`, origin: "manual", cols, rows });
    return { sessionId: terminal.sessionId, terminalId: terminal.id };
  }),
);

api.post(
  "/sessions/:id/resume",
  wrap((req) => {
    const { cols, rows } = req.body ?? {};
    const terminal = startSession({ resumeId: req.params.id, cols, rows });
    return { sessionId: terminal.sessionId, terminalId: terminal.id };
  }),
);

api.post(
  "/sessions/:id/kill",
  wrap((req) => {
    const terminal = terminalForSession(req.params.id);
    if (!terminal) throw new Error("That session has no running terminal.");
    killTerminal(terminal);
  }),
);

api.put("/sessions/:id/title", wrap((req) => setSessionTitle(req.params.id, String(req.body?.title ?? ""))));
/** What a delete would remove, shown in the confirmation before anything goes. */
api.get("/sessions/:id/deletion", wrap((req) => deletionPlan(req.params.id)));
api.delete("/sessions/:id", wrap((req) => deleteSession(req.params.id, { clearTemp: req.query.temp !== "0" })));

/**
 * A live session only takes a new toolset at start-up, so it is restarted on
 * the same conversation; a stopped one keeps it for its next resume.
 */
api.put(
  "/sessions/:id/toolset",
  wrap(async (req) => {
    const toolset = normaliseToolset(req.body?.toolset);
    if (terminalForSession(req.params.id)) {
      const terminal = await restartSession(req.params.id, { toolset });
      return { restarted: true, terminalId: terminal.id };
    }
    setSessionToolset(req.params.id, toolset);
    return { restarted: false };
  }),
);

/** The Setup tab: saved, then a live session is restarted on the same conversation so its prompt carries it. */
api.put(
  "/sessions/:id/setup",
  wrap(async (req) => {
    setSessionSetup(req.params.id, normaliseSetup(req.body));
    if (!terminalForSession(req.params.id)) return { restarted: false };
    const terminal = await restartSession(req.params.id);
    return { restarted: true, terminalId: terminal.id };
  }),
);

// Toolsets ---------------------------------------------------------------

api.get("/toolset/catalog", wrap(() => toolsetCatalog()));
api.put("/toolset/default", wrap((req) => setDefaultItem(req.body ?? {})));
api.get("/presets", wrap(() => listPresets()));
api.post("/presets", wrap((req) => savePreset(req.body ?? {})));
api.put("/presets/:id", wrap((req) => savePreset({ ...(req.body ?? {}), id: req.params.id })));
api.delete("/presets/:id", wrap((req) => deletePreset(req.params.id)));

// Claude settings --------------------------------------------------------

api.get("/claude-settings", wrap(() => ({ settings: claudeSettings(), permissionModes: PERMISSION_MODES, efforts: EFFORTS })));
api.put("/claude-settings", wrap((req) => saveClaudeSettings(req.body ?? {})));

api.get("/mcp-suggestions/enabled", wrap(() => ({ enabled: mcpSuggestionsEnabled() })));
api.put("/mcp-suggestions/enabled", wrap((req) => ({ enabled: setMcpSuggestionsEnabled(req.body?.enabled === true) })));

// Interactions -----------------------------------------------------------

api.get("/interactions", wrap((req) => withPresentation(listInteractions({ status: req.query.status ? String(req.query.status) : undefined, limit: 200 }))));

api.post("/interactions/:id/choose", wrap((req) => chooseInteraction(req.params.id, String(req.body?.ref ?? ""), "dashboard")));
api.post(
  "/interactions/:id/answer",
  wrap((req) => answerInteraction(req.params.id, String(req.body?.answer ?? ""), "dashboard")),
);

// Visualisation ----------------------------------------------------------

api.get("/inventory", wrap(() => readInventory()));

api.get(
  "/stats",
  wrap(() => {
    const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    const add = (into: Tokens, from: Tokens) => {
      for (const key of Object.keys(into) as Array<keyof Tokens>) into[key] += from[key];
    };
    const tokens = zero();
    const byModel: Record<string, Tokens> = {};
    const byDay: Record<string, Tokens> = {};
    const tools: Record<string, { count: number; errors: number }> = {};
    const skills: Record<string, number> = {};
    const agents: Record<string, { count: number; tokens: Tokens }> = {};
    const sessions = listTranscripts();
    for (const summary of sessions) {
      const detail = transcriptDetail(summary.id);
      if (!detail) continue;
      add(tokens, detail.totals.tokens);
      for (const [model, value] of Object.entries(detail.totals.tokensByModel)) add((byModel[model] ??= zero()), value);
      const day = (detail.startedAt ?? "").slice(0, 10);
      if (day) add((byDay[day] ??= zero()), detail.totals.tokens);
      for (const [name, value] of Object.entries(detail.totals.tools)) {
        const entry = (tools[name] ??= { count: 0, errors: 0 });
        entry.count += value.count;
        entry.errors += value.errors;
      }
      for (const [name, count] of Object.entries(detail.skills)) skills[name] = (skills[name] ?? 0) + count;
      for (const sub of detail.subagents) {
        const entry = (agents[sub.agentType] ??= { count: 0, tokens: zero() });
        entry.count += 1;
        add(entry.tokens, sub.tokens);
      }
    }
    return { sessions: sessions.length, tokens, byModel, byDay, tools, skills, agents };
  }),
);

// Categories and prompts -------------------------------------------------

api.get("/categories", wrap(() => listCategories()));
api.post("/categories", wrap((req) => saveCategory(req.body ?? {})));
api.put("/categories/:id", wrap((req) => saveCategory({ ...(req.body ?? {}), id: req.params.id })));
api.delete("/categories/:id", wrap((req) => deleteCategory(req.params.id)));

api.get("/prompts", wrap(() => promptDefinitions()));
api.put(
  "/prompts/:key",
  wrap((req) => {
    const text = req.body?.text;
    setPrompt(req.params.key, typeof text === "string" ? text : null);
    return promptDefinitions();
  }),
);
api.get("/prompts/preview", wrap((req) => ({ text: systemPromptFor(req.query.category ? String(req.query.category) : null) })));

api.get("/memory", wrap(() => memoryFiles()));
api.get(
  "/memory/file",
  wrap((req) => {
    const file = String(req.query.path ?? "");
    const writable = isMemoryFile(file);
    if (!writable && !isDefinitionFile(file)) throw new Error("Not one of the files the hub manages.");
    return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", writable };
  }),
);
api.put(
  "/memory/file",
  wrap((req) => {
    const file = String(req.body?.path ?? "");
    const content = req.body?.content;
    if (!isMemoryFile(file)) throw new Error("Not one of the files the hub manages.");
    if (typeof content !== "string") throw new Error("No content.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return { path: file, content };
  }),
);

// Channels ---------------------------------------------------------------

api.get("/channels", wrap(() => ({ kinds: CHANNEL_KINDS, interactionKinds: INTERACTION_KINDS, channels: listChannels() })));
api.post("/channels", wrap((req) => saveChannel(req.body ?? {})));
api.put("/channels/:id", wrap((req) => saveChannel({ ...(req.body ?? {}), id: req.params.id })));
api.delete("/channels/:id", wrap((req) => deleteChannel(req.params.id)));
api.post("/channels/:id/test", wrap((req) => testChannel(req.params.id)));
api.post(
  "/channels/:id/reply",
  wrap(async (req) => ({ result: await httpReply(req.params.id, req.get("x-clauder-secret") ?? undefined, req.body) })),
);

// Jobs, triggers and the queue -------------------------------------------

api.get("/jobs", wrap(() => listJobs()));
api.post("/jobs", wrap((req) => saveJob(req.body ?? {})));
api.put("/jobs/:id", wrap((req) => saveJob({ ...(req.body ?? {}), id: req.params.id })));
api.delete("/jobs/:id", wrap((req) => deleteJob(req.params.id)));
api.post("/jobs/:id/rotate", wrap((req) => rotateToken(req.params.id)));
api.post(
  "/jobs/:id/run",
  wrap((req) => {
    const job = getJob(req.params.id);
    if (!job) throw new Error("No such job.");
    return enqueue({ job, source: "manual", payload: req.body?.payload ?? {} });
  }),
);

/** The webhook other tools call. Local only for now: the hub listens on 127.0.0.1. */
api.post(
  "/trigger/:id",
  wrap((req, res) => {
    const job = getJob(req.params.id);
    const token = req.get("x-clauder-token") ?? String(req.query.token ?? "");
    if (!job || job.kind !== "webhook" || job.token !== token) {
      res.status(404).json({ error: "No such trigger, or the token is wrong." });
      return;
    }
    if (!job.enabled) {
      res.status(409).json({ error: "This trigger is disabled." });
      return;
    }
    const { run, position } = enqueue({ job, source: "webhook", payload: req.body ?? {} });
    return { runId: run.id, status: run.status, position };
  }),
);

api.get("/runs", wrap(() => listRuns()));
api.post("/runs", wrap((req) => enqueue({ source: "manual", prompt: String(req.body?.prompt ?? ""), category: req.body?.category || "auto" })));
api.post("/runs/:id/cancel", wrap((req) => cancelRun(req.params.id)));

// MCP suggestions --------------------------------------------------------

api.get("/mcp/suggestions", wrap(() => listSuggestions()));
/** Well-known servers to recommend, each marked when this project already has it. */
api.get(
  "/mcp/catalog",
  wrap(() => {
    const configured = new Set(readInventory().mcpServers.map((server) => server.name.toLowerCase()));
    return MCP_CATALOG.map((entry) => ({ ...entry, installed: configured.has(entry.serverName.toLowerCase()) }));
  }),
);
api.post("/mcp/install", wrap((req) => installServer(req.body?.command, req.body?.scope)));
api.post("/mcp/suggestions/:id/install", wrap((req) => installSuggestion(req.params.id, "dashboard")));
api.post("/mcp/suggestions/:id/skip", wrap((req) => skipSuggestion(req.params.id, String(req.body?.note ?? ""))));
api.delete("/mcp/suggestions/:id", wrap((req) => deleteSuggestion(req.params.id)));

// Hooks: answered at once and empty, so they never hold Claude up or decide anything.
// The token names the terminal, and so the project the hook is handled in.
hubApi.post("/hooks/:token", (req, res) => {
  res.json({});
  const terminal = terminalByToken(req.params.token);
  const project = terminal ? getProject(terminal.projectId) : null;
  if (!project) return;
  withProject(project, () => handleHook(req.params.token, req.body)).catch((error) => console.error("[hook]", error));
});

/**
 * Webhook URLs from before projects were in the path: a job or channel id is
 * unique, so the project that has it takes the call.
 */
function inProjectWith(find: () => unknown): ReturnType<typeof getProject> {
  return allProjects().find((project) => withProject(project, () => Boolean(find()))) ?? null;
}
hubApi.post("/trigger/:id", (req, res, next) => {
  const project = inProjectWith(() => getJob(req.params.id));
  if (!project) return void res.status(404).json({ error: "No such trigger, or the token is wrong." });
  withProject(project, () => api(req, res, next));
});
hubApi.post("/channels/:id/reply", (req, res, next) => {
  const project = inProjectWith(() => listChannels().some((channel) => channel.id === req.params.id));
  if (!project) return void res.status(404).json({ error: "No such webhook channel." });
  withProject(project, () => api(req, res, next));
});

