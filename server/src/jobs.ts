import { Cron } from "croner";
import { nanoid } from "nanoid";
import { claudeSettings } from "./claudeSettings.js";
import { bindProject, currentProject } from "./context.js";
import { db, now } from "./db.js";
import { broadcast } from "./events.js";
import { render } from "./prompts.js";
import { getSessionRow, setSessionStatus, startSession } from "./sessions.js";
import { onTerminalExit } from "./terminals.js";
import { getPreset } from "./toolset.js";

/**
 * Jobs start sessions without anyone at the keyboard: on a cron schedule, or
 * when something POSTs to the job's webhook. Every start goes through one
 * queue and runs one session at a time, because they all work in the same
 * checkout. A run ends when its session reports done (see hooks.ts) or its
 * terminal exits.
 */
export interface Job {
  id: string;
  name: string;
  kind: "cron" | "webhook";
  schedule: string;
  prompt: string;
  category: string;
  /** The toolset preset its runs start with; null is the default preset. */
  presetId: string | null;
  token: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface Run {
  id: string;
  jobId: string | null;
  jobName: string | null;
  source: "cron" | "webhook" | "manual";
  prompt: string;
  category: string;
  status: "queued" | "running" | "done" | "exited" | "cancelled";
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  name: string;
  kind: Job["kind"];
  schedule: string;
  prompt: string;
  category: string;
  token: string;
  enabled: number;
  preset_id: string | null;
  last_run_at: string | null;
  created_at: string;
}

/** Every project's cron jobs, keyed <project id>:<job id>. */
const crons = new Map<string, Cron>();
const cronKey = (jobId: string) => `${currentProject().id}:${jobId}`;

const toJob = (row: JobRow): Job => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  schedule: row.schedule,
  prompt: row.prompt,
  category: row.category,
  presetId: row.preset_id,
  token: row.token,
  enabled: Boolean(row.enabled),
  lastRunAt: row.last_run_at,
  nextRunAt: crons.get(cronKey(row.id))?.nextRun()?.toISOString() ?? null,
  createdAt: row.created_at,
});

export function listJobs(): Job[] {
  return (db.prepare("SELECT * FROM jobs ORDER BY created_at").all() as JobRow[]).map(toJob);
}

export function getJob(id: string): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function saveJob(input: { id?: string; name: string; kind: Job["kind"]; schedule?: string; prompt: string; category?: string; presetId?: string | null; enabled?: boolean }): Job {
  if (!input.name.trim()) throw new Error("A job needs a name.");
  if (!input.prompt.trim()) throw new Error("A job needs a prompt.");
  if (input.kind !== "cron" && input.kind !== "webhook") throw new Error("A job is either cron or webhook.");
  const schedule = (input.schedule ?? "").trim();
  if (input.kind === "cron") {
    try {
      new Cron(schedule, { paused: true }).stop();
    } catch (error) {
      throw new Error(`The schedule is not a valid cron expression: ${(error as Error).message}`);
    }
  }
  const id = input.id ?? nanoid(10);
  const token = (getJob(id)?.token ?? nanoid(32)) as string;
  db.prepare(
    `INSERT INTO jobs (id, name, kind, schedule, prompt, category, preset_id, token, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, schedule = excluded.schedule, prompt = excluded.prompt,
       category = excluded.category, preset_id = excluded.preset_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(id, input.name.trim(), input.kind, schedule, input.prompt, input.category ?? "auto", input.presetId || null, token, input.enabled === false ? 0 : 1, now(), now());
  schedule_(id);
  broadcast("jobs", {});
  return getJob(id)!;
}

export function deleteJob(id: string): void {
  crons.get(cronKey(id))?.stop();
  crons.delete(cronKey(id));
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  broadcast("jobs", {});
}

export function rotateToken(id: string): Job {
  db.prepare("UPDATE jobs SET token = ? WHERE id = ?").run(nanoid(32), id);
  broadcast("jobs", {});
  return getJob(id)!;
}

function schedule_(id: string): void {
  const key = cronKey(id);
  crons.get(key)?.stop();
  crons.delete(key);
  const job = getJob(id);
  if (!job || !job.enabled || job.kind !== "cron") return;
  crons.set(
    key,
    new Cron(
      job.schedule,
      { protect: true },
      // A tick fires from a timer: it runs in the job's project.
      bindProject(() => {
        enqueue({ job, source: "cron", payload: { firedAt: now() } });
      }),
    ),
  );
}

export function startScheduler(): void {
  for (const job of listJobs()) schedule_(job.id);
}

/** Stops the current project's cron jobs. */
export function stopScheduler(): void {
  const prefix = `${currentProject().id}:`;
  for (const [key, cron] of crons) {
    if (!key.startsWith(prefix)) continue;
    cron.stop();
    crons.delete(key);
  }
}

/** {{payload}} is the whole body as JSON, {{payload.a.b}} one value in it, {{now}} the time. */
function renderJobPrompt(template: string, payload: unknown): string {
  const values: Record<string, string> = { now: now(), payload: JSON.stringify(payload ?? {}, null, 2) };
  const walk = (value: unknown, prefix: string) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${prefix}.${key}`);
    }
    values[prefix] = typeof value === "string" ? value : JSON.stringify(value);
  };
  if (payload && typeof payload === "object") for (const [key, inner] of Object.entries(payload)) walk(inner, `payload.${key}`);
  return render(template, values);
}

interface RunRow {
  id: string;
  job_id: string | null;
  source: Run["source"];
  prompt: string;
  category: string;
  status: Run["status"];
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  job_name: string | null;
}

const toRun = (row: RunRow): Run => ({
  id: row.id,
  jobId: row.job_id,
  jobName: row.job_name,
  source: row.source,
  prompt: row.prompt,
  category: row.category,
  status: row.status,
  sessionId: row.session_id,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export function listRuns(limit = 100): Run[] {
  return (
    db
      .prepare("SELECT runs.*, jobs.name AS job_name FROM runs LEFT JOIN jobs ON jobs.id = runs.job_id ORDER BY runs.created_at DESC LIMIT ?")
      .all(limit) as RunRow[]
  ).map(toRun);
}

export function enqueue(input: { job?: Job; source: Run["source"]; payload?: unknown; prompt?: string; category?: string }): { run: Run; position: number } {
  const prompt = input.job ? renderJobPrompt(input.job.prompt, input.payload) : (input.prompt ?? "");
  if (!prompt.trim()) throw new Error("Nothing to run: the prompt is empty.");
  const id = nanoid(10);
  db.prepare("INSERT INTO runs (id, job_id, source, prompt, category, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)").run(
    id,
    input.job?.id ?? null,
    input.source,
    prompt,
    input.category ?? input.job?.category ?? "auto",
    now(),
  );
  if (input.job) db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(now(), input.job.id);
  broadcast("runs", {});
  broadcast("jobs", {});
  const position = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued' AND created_at <= (SELECT created_at FROM runs WHERE id = ?)").get(id) as { n: number }).n;
  advance();
  const run = listRuns(500).find((item) => item.id === id)!;
  return { run, position };
}

export function cancelRun(id: string): void {
  db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), id);
  broadcast("runs", {});
}

function finishRun(runId: string, status: "done" | "exited"): void {
  db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(status, now(), runId);
  broadcast("runs", {});
}

let advancing = false;

/**
 * Runs the queue again a moment later, in this project. A project removed
 * meanwhile has its database closed: that is not an error, and a throw from a
 * timer would take the whole hub down.
 */
function advanceSoon(ms: number): void {
  const run = bindProject(advance);
  setTimeout(() => {
    try {
      run();
    } catch (error) {
      console.error("[queue]", (error as Error).message);
    }
  }, ms);
}

/** Starts the oldest queued run when nothing queued is running. */
export function advance(): void {
  if (advancing) return;
  advancing = true;
  try {
    const running = db.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").get();
    if (running) return;
    const next = db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as RunRow | undefined;
    if (!next) return;
    const job = next.job_id ? getJob(next.job_id) : null;
    try {
      const terminal = startSession({
        prompt: next.prompt,
        origin: next.source === "manual" ? "queue" : next.source,
        runId: next.id,
        category: next.category || "auto",
        // Unattended runs use their own mode from Claude settings; "" leaves it to the user's settings.
        permissionMode: claudeSettings().runPermissionMode,
        // A job's own preset; without one, startSession falls back to the default preset.
        toolset: job?.presetId ? getPreset(job.presetId)?.toolset : undefined,
        name: job ? `${job.name} ${new Date().toISOString().slice(0, 16).replace("T", " ")}` : undefined,
      });
      db.prepare("UPDATE runs SET status = 'running', session_id = ?, started_at = ? WHERE id = ?").run(terminal.sessionId, now(), next.id);
    } catch (error) {
      console.error("[queue] could not start a run:", (error as Error).message);
      db.prepare("UPDATE runs SET status = 'exited', finished_at = ? WHERE id = ?").run(now(), next.id);
      advanceSoon(1000);
    }
    broadcast("runs", {});
  } finally {
    advancing = false;
  }
}

/** A session's terminal closing settles its run and lets the next one start. */
export function watchRunExits(): void {
  onTerminalExit((terminal) => {
    if (terminal.restarting) return;
    const row = getSessionRow(terminal.sessionId);
    if (row && row.status !== "done") setSessionStatus(terminal.sessionId, "exited");
    if (row?.run_id) finishRun(row.run_id, row.status === "done" ? "done" : "exited");
    advanceSoon(500);
  });
}

/** A run cannot outlive the hub's process: its terminal died with it. */
export function recoverRuns(): number {
  const stranded = db.prepare("UPDATE runs SET status = 'exited', finished_at = ? WHERE status = 'running'").run(now()).changes;
  db.prepare("UPDATE sessions SET status = 'exited' WHERE status IN ('running', 'waiting')").run();
  db.prepare("UPDATE interactions SET status = 'closed', answered_by = 'hub restart' WHERE status = 'open'").run();
  return stranded;
}
