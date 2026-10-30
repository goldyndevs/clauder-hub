import Database from "better-sqlite3";
import path from "node:path";
import { currentProject } from "./context.js";
import { ensureLayout, hubHome } from "./paths.js";

ensureLayout();

/**
 * The current project's database (see context.ts). Every module keeps writing
 * `db.prepare(...)`; this forwards each call to the project it runs for.
 */
export const db = new Proxy({} as Database.Database, {
  get(_target, key) {
    const database = currentProject().db as unknown as Record<PropertyKey, unknown>;
    const value = database[key];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(database) : value;
  },
});

/**
 * The hub's own database, one per machine: which projects it manages, and
 * what belongs to the hub rather than a project (the rewritten hub prompts).
 */
export const globalDb = new Database(path.join(hubHome, "hub.db"));
globalDb.pragma("journal_mode = WAL");
globalDb.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,                     -- the route: #/<id>/...
  root       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  opened_at  TEXT NOT NULL
);

-- The dashboard's own prompts, when the user has rewritten one.
CREATE TABLE IF NOT EXISTS prompt_overrides (
  key        TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

/** Opens a project's database, creating or upgrading its tables. */
export function openProjectDb(file: string): Database.Database {
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  applySchema(database);
  return database;
}

/**
 * Only what Claude Code does not record itself lives here. Transcripts, tokens
 * and tool calls are read from ~/.claude every time; this is the hub's own
 * bookkeeping around them.
 */
function applySchema(database: Database.Database): void {
  database.exec(`
-- Sessions the hub started or touched. A session that only exists in
-- ~/.claude (started in a plain terminal) has no row and shows as external.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                    -- the Claude Code session id
  origin      TEXT NOT NULL DEFAULT 'manual',      -- manual | cron | webhook | queue
  run_id      TEXT,
  category    TEXT,                                -- '' none | 'auto' | a category name
  status      TEXT NOT NULL DEFAULT 'running',     -- running | waiting | done | exited
  done_json   TEXT,                                -- what Claude reported when it said done
  done_attempts INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Anything a session asked of a human, wherever it was answered.
CREATE TABLE IF NOT EXISTS interactions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                       -- permission | question | turn | mcp | done
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',
  data        TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',        -- open | answered | closed
  answered_by TEXT,
  answer      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                       -- slack | telegram | http
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT NOT NULL DEFAULT '{}',
  kinds       TEXT NOT NULL DEFAULT '["permission","question","turn","mcp","done"]',
  created_at  TEXT NOT NULL
);

-- Where a message about a session landed on a channel, so a reply finds its way back.
CREATE TABLE IF NOT EXISTS channel_refs (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ref         TEXT NOT NULL,                       -- slack thread ts, telegram message id, ...
  session_id  TEXT NOT NULL,
  interaction_id TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (channel_id, ref)
);

-- A session's conversation thread on a channel, for channels that thread.
CREATE TABLE IF NOT EXISTS channel_threads (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  thread      TEXT NOT NULL,
  PRIMARY KEY (channel_id, session_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '[]',         -- [{ name, description, required }]
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                       -- cron | webhook
  schedule    TEXT NOT NULL DEFAULT '',            -- cron expression, for kind = cron
  prompt      TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'auto',
  token       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The one queue: triggered work runs one session at a time, in order.
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  source      TEXT NOT NULL,                       -- cron | webhook | manual
  prompt      TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'auto',
  status      TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | exited | cancelled
  session_id  TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_suggestions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  command     TEXT NOT NULL,
  docs        TEXT,
  status      TEXT NOT NULL DEFAULT 'suggested',   -- suggested | installed | failed | dismissed
  output      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The project's own settings (Claude settings, MCP suggestions on or off), one JSON value per key.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

-- What a session may use: agents, skills, MCP servers and plugins turned off
-- for it, saved under a name so jobs and new sessions can reuse it.
CREATE TABLE IF NOT EXISTS presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  toolset     TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at);
  `);

  /** Adds a column to an existing database; new installs get it from the schema above. */
  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  // The toolset a session was started with, kept so a resume starts it the same way.
  ensureColumn("sessions", "toolset", "TEXT");
  // Null means the default preset at the time the run starts.
  ensureColumn("jobs", "preset_id", "TEXT");
  // A configuration session's purpose (creating a job, editing a channel, ...), as JSON.
  ensureColumn("sessions", "purpose", "TEXT");
  // What the person set up for one session (Setup tab): notes and named values for its system prompt, as JSON.
  ensureColumn("sessions", "setup", "TEXT");
  // In the global context, which project a channel message or thread belongs to; null in a project's own.
  ensureColumn("channel_refs", "project_id", "TEXT");
  ensureColumn("channel_threads", "project_id", "TEXT");
}

export function now(): string {
  return new Date().toISOString();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
