import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalDb, now, parseJson } from "./db.js";
import { claudeHome, projectRoot } from "./paths.js";

/**
 * The values Claude Code is given through its own files: MCP servers' env and
 * headers (.mcp.json, ~/.claude.json) and the env of every settings file. Read
 * here, shown masked, revealed one at a time, and rewritten in place when the
 * person rotates one; nothing else in those files is touched.
 *
 * When a token runs out is read where it can be: a JWT carries it, GitHub says
 * it when asked (only on Check, and only to GitHub), and for the rest the
 * person notes a date. All of that is the hub's own, kept per machine.
 */
export const variableRoutes = express.Router();

globalDb.exec(`
CREATE TABLE IF NOT EXISTS variable_meta (
  id          TEXT PRIMARY KEY,   -- hash of the file and the place in it
  expires_at  TEXT,               -- noted by the person
  check_json  TEXT,               -- the last Check: { at, ok, detail, expiresAt }
  updated_at  TEXT NOT NULL
);
`);

type Scope = "user" | "project" | "local";
type Kind = "jwt" | "github" | "slack" | "slack-app" | "npm" | "anthropic" | "openai" | "atlassian" | null;

interface Located {
  id: string;
  name: string;
  file: string;
  /** Keys from the file's top level down to the value. */
  keys: string[];
  scope: Scope;
  /** Where in the file, for a person: an MCP server's env or headers, or a settings file's env. */
  where: string;
  server: string | null;
  value: string;
}

interface Check {
  at: string;
  ok: boolean;
  detail: string;
  expiresAt: string | null;
}

export interface VariableView {
  id: string;
  name: string;
  file: string;
  scope: Scope;
  where: string;
  server: string | null;
  /** The value as shown: plain when it is not a secret, masked when it is. */
  shown: string;
  secret: boolean;
  /** The ${NAME} it stands for, when the file holds a reference rather than the value. */
  reference: string | null;
  /** Whether that reference has a value on this machine (the environment, or a settings env). */
  resolved: boolean | null;
  kind: Kind;
  expiresAt: string | null;
  expirySource: "token" | "check" | "noted" | null;
  check: Check | null;
  checkable: boolean;
  editable: boolean;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const idOf = (file: string, keys: string[]) => crypto.createHash("sha1").update(`${path.resolve(file).toLowerCase()}\0${keys.join("\0")}`).digest("hex").slice(0, 16);

/** ~/.claude.json keys projects by path, with forward slashes in newer versions. */
function localProjectKey(config: any): string | null {
  const wanted = [projectRoot(), projectRoot().replace(/\\/g, "/")].map((item) => item.toLowerCase());
  return Object.keys(config?.projects ?? {}).find((key) => wanted.includes(key.toLowerCase())) ?? null;
}

function locate(): Located[] {
  const found: Located[] = [];
  const add = (file: string, keys: string[], scope: Scope, where: string, server: string | null, value: unknown) => {
    if (typeof value !== "string") return;
    found.push({ id: idOf(file, keys), name: keys[keys.length - 1], file, keys, scope, where, server, value });
  };
  const servers = (file: string, base: string[], scope: Scope, list: any) => {
    for (const [server, config] of Object.entries((list ?? {}) as Record<string, any>)) {
      for (const [name, value] of Object.entries((config?.env ?? {}) as Record<string, unknown>)) add(file, [...base, server, "env", name], scope, `MCP server ${server}, env`, server, value);
      for (const [name, value] of Object.entries((config?.headers ?? {}) as Record<string, unknown>)) add(file, [...base, server, "headers", name], scope, `MCP server ${server}, header`, server, value);
    }
  };

  const mcpJson = path.join(projectRoot(), ".mcp.json");
  servers(mcpJson, ["mcpServers"], "project", readJson(mcpJson)?.mcpServers);
  const globalFile = path.join(os.homedir(), ".claude.json");
  const global = readJson(globalFile);
  servers(globalFile, ["mcpServers"], "user", global?.mcpServers);
  const key = localProjectKey(global);
  if (key) servers(globalFile, ["projects", key, "mcpServers"], "local", global.projects[key]?.mcpServers);

  const settings: Array<[string, Scope]> = [
    [path.join(claudeHome, "settings.json"), "user"],
    [path.join(projectRoot(), ".claude", "settings.json"), "project"],
    [path.join(projectRoot(), ".claude", "settings.local.json"), "local"],
  ];
  for (const [file, scope] of settings) {
    for (const [name, value] of Object.entries((readJson(file)?.env ?? {}) as Record<string, unknown>)) add(file, ["env", name], scope, "settings env", null, value);
  }
  return found;
}

const SECRET_NAME = /token|secret|password|passwd|pass\b|api[_-]?key|apikey|auth|credential|bearer|cookie|private|_key$|^key$/i;
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;

/** The token in a value: a header's "Bearer x" or "token x" is the x. */
const tokenPart = (value: string) => value.replace(/^(bearer|token|basic)\s+/i, "").trim();

function kindOf(value: string): Kind {
  const token = tokenPart(value);
  if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(token)) return "jwt";
  if (/^(ghp_|github_pat_|gho_|ghu_|ghs_)/.test(token)) return "github";
  if (/^xox[abpe]-/.test(token)) return "slack";
  if (/^xapp-/.test(token)) return "slack-app";
  if (/^npm_/.test(token)) return "npm";
  if (/^sk-ant-/.test(token)) return "anthropic";
  if (/^sk-/.test(token)) return "openai";
  if (/^ATATT/.test(token)) return "atlassian";
  return null;
}

function jwtExpiry(value: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(tokenPart(value).split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const mask = (value: string) => (value.length <= 10 ? "•".repeat(Math.max(4, value.length)) : `${value.slice(0, 4)}${"•".repeat(6)}${value.slice(-2)}`);

/** What a ${NAME} reference stands for here: the environment first, then any settings env. */
function resolveReference(name: string, all: Located[]): string | null {
  if (process.env[name]) return process.env[name]!;
  return all.find((item) => item.where === "settings env" && item.name === name)?.value ?? null;
}

function meta(id: string): { expiresAt: string | null; check: Check | null } {
  const row = globalDb.prepare("SELECT expires_at, check_json FROM variable_meta WHERE id = ?").get(id) as { expires_at: string | null; check_json: string | null } | undefined;
  return { expiresAt: row?.expires_at ?? null, check: parseJson<Check | null>(row?.check_json, null) };
}

function saveMeta(id: string, patch: { expiresAt?: string | null; check?: Check }): void {
  const current = meta(id);
  globalDb
    .prepare(
      `INSERT INTO variable_meta (id, expires_at, check_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, check_json = excluded.check_json, updated_at = excluded.updated_at`,
    )
    .run(id, patch.expiresAt !== undefined ? patch.expiresAt : current.expiresAt, JSON.stringify(patch.check ?? current.check), now());
}

const CHECKABLE: Kind[] = ["github", "slack", "npm"];

function view(item: Located, all: Located[]): VariableView {
  const reference = REFERENCE.exec(item.value)?.[1] ?? null;
  const actual = reference ? resolveReference(reference, all) : item.value;
  const kind = actual ? kindOf(actual) : null;
  const secret = Boolean(kind) || SECRET_NAME.test(item.name);
  const stored = meta(item.id);
  const fromToken = kind === "jwt" && actual ? jwtExpiry(actual) : null;
  const expiresAt = fromToken ?? stored.check?.expiresAt ?? stored.expiresAt;
  return {
    id: item.id,
    name: item.name,
    file: item.file,
    scope: item.scope,
    where: item.where,
    server: item.server,
    shown: reference ? item.value : secret ? mask(item.value) : item.value,
    secret,
    reference,
    resolved: reference ? actual !== null : null,
    kind,
    expiresAt,
    expirySource: fromToken ? "token" : stored.check?.expiresAt ? "check" : stored.expiresAt ? "noted" : null,
    check: stored.check,
    checkable: Boolean(actual) && CHECKABLE.includes(kind),
    // A reference is set where it is defined, not here: writing a value over it would put the secret into the file.
    editable: !reference,
  };
}

export function listVariables(): VariableView[] {
  const all = locate();
  return all.map((item) => view(item, all));
}

function find(id: string): { item: Located; all: Located[] } {
  const all = locate();
  const item = all.find((entry) => entry.id === id);
  if (!item) throw new Error("That variable is no longer in its file.");
  return { item, all };
}

/** The real value: the file's, or what its reference stands for. */
function actualValue(item: Located, all: Located[]): string | null {
  const reference = REFERENCE.exec(item.value)?.[1];
  return reference ? resolveReference(reference, all) : item.value;
}

/**
 * Writes one value into its file, read again just before so a change Claude
 * Code made since is kept; the rest of the file keeps its indentation, line
 * endings and final newline. Written beside and renamed over, so the file is
 * never half-written.
 */
export function writeVariable(id: string, value: string): VariableView {
  const { item } = find(id);
  if (REFERENCE.test(item.value)) throw new Error(`It refers to \${${REFERENCE.exec(item.value)![1]}}; change it where that is set.`);
  const text = fs.readFileSync(item.file, "utf8");
  const data = JSON.parse(text);
  let node = data;
  for (const key of item.keys.slice(0, -1)) {
    node = node?.[key];
    if (!node || typeof node !== "object") throw new Error("The file changed; reload and try again.");
  }
  const last = item.keys[item.keys.length - 1];
  if (typeof node[last] !== "string") throw new Error("The file changed; reload and try again.");
  node[last] = value;
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(data, null, indent).replace(/\n/g, eol);
  if (/\r?\n$/.test(text)) out += eol;
  const temp = `${item.file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, out, "utf8");
  try {
    fs.renameSync(temp, item.file);
  } catch {
    // A file another program holds open cannot be replaced on Windows: written in place instead.
    fs.writeFileSync(item.file, out, "utf8");
    fs.rmSync(temp, { force: true });
  }
  // A new token's old check says nothing about it.
  globalDb.prepare("UPDATE variable_meta SET check_json = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  return listVariables().find((entry) => entry.id === id) ?? view({ ...item, value }, []);
}

/** Asks the token's own service whether it still works, and GitHub when it runs out. */
async function checkToken(kind: Kind, value: string): Promise<Check> {
  const token = tokenPart(value);
  const at = new Date().toISOString();
  const signal = AbortSignal.timeout(10_000);
  if (kind === "github") {
    const response = await fetch("https://api.github.com/user", { headers: { authorization: `token ${token}`, "user-agent": "clauder-hub", accept: "application/vnd.github+json" }, signal });
    const header = response.headers.get("github-authentication-token-expiration");
    const expiresAt = header ? new Date(header.replace(" UTC", "Z").replace(" ", "T")).toISOString() : null;
    if (!response.ok) return { at, ok: false, detail: `GitHub answered ${response.status}: the token is not accepted.`, expiresAt };
    const user = (await response.json().catch(() => ({}))) as { login?: string };
    return { at, ok: true, detail: `Works as ${user.login ?? "a GitHub user"}${expiresAt ? "" : "; it does not expire"}.`, expiresAt };
  }
  if (kind === "slack") {
    const response = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` }, signal });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; team?: string; user?: string };
    return body.ok ? { at, ok: true, detail: `Works for ${body.user ?? "a user"} in ${body.team ?? "the workspace"}.`, expiresAt: null } : { at, ok: false, detail: `Slack says ${body.error ?? response.status}.`, expiresAt: null };
  }
  if (kind === "npm") {
    const response = await fetch("https://registry.npmjs.org/-/whoami", { headers: { authorization: `Bearer ${token}` }, signal });
    const body = (await response.json().catch(() => ({}))) as { username?: string };
    return response.ok ? { at, ok: true, detail: `Works as ${body.username ?? "an npm user"}.`, expiresAt: null } : { at, ok: false, detail: `npm answered ${response.status}: the token is not accepted.`, expiresAt: null };
  }
  throw new Error("This kind of token cannot be checked.");
}

/** Values leave the hub only for this page: a request from any other site is refused. */
function samePage(req: express.Request, res: express.Response): boolean {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    res.status(403).json({ error: "Not from this page." });
    return false;
  }
  return true;
}

const fail = (res: express.Response, error: unknown) => res.status(400).json({ error: (error as Error).message });

variableRoutes.get("/variables", (_req, res) => {
  try {
    res.json(listVariables());
  } catch (error) {
    fail(res, error);
  }
});

variableRoutes.get("/variables/:id/value", (req, res) => {
  if (!samePage(req, res)) return;
  try {
    const { item, all } = find(req.params.id);
    res.json({ value: actualValue(item, all) });
  } catch (error) {
    fail(res, error);
  }
});

variableRoutes.put("/variables/:id", express.json(), (req, res) => {
  if (!samePage(req, res)) return;
  const value = req.body?.value;
  if (typeof value !== "string") return void res.status(400).json({ error: "A value is needed." });
  try {
    res.json(writeVariable(req.params.id, value));
  } catch (error) {
    fail(res, error);
  }
});

variableRoutes.put("/variables/:id/expiry", express.json(), (req, res) => {
  const date = req.body?.expiresAt;
  if (date !== null && (typeof date !== "string" || Number.isNaN(Date.parse(date)))) return void res.status(400).json({ error: "A date, or null to clear it." });
  try {
    find(req.params.id);
    saveMeta(req.params.id, { expiresAt: date ? new Date(date).toISOString() : null });
    res.json(listVariables().find((entry) => entry.id === req.params.id));
  } catch (error) {
    fail(res, error);
  }
});

variableRoutes.post("/variables/:id/check", async (req, res) => {
  if (!samePage(req, res)) return;
  try {
    const { item, all } = find(req.params.id);
    const value = actualValue(item, all);
    if (!value) throw new Error("It has no value here to check.");
    const check = await checkToken(kindOf(value), value);
    saveMeta(item.id, { check });
    res.json(listVariables().find((entry) => entry.id === item.id));
  } catch (error) {
    fail(res, error);
  }
});
