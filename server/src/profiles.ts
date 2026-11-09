import fs from "node:fs";
import path from "node:path";
import { readAuth, type AuthInfo } from "./claudeCode.js";
import { claudeSettings } from "./claudeSettings.js";
import { globalDb, now } from "./db.js";
import { claudeHome, hubHome, setExtraConfigDirs, transcriptFile } from "./paths.js";

/**
 * Several Claude accounts on one machine. Each account is a profile: a
 * Claude Code config folder of its own (CLAUDE_CONFIG_DIR), so its sign-in,
 * its .claude.json and its transcripts are its own, and sessions of different
 * accounts run side by side. "default" is the folder Claude Code uses anyway
 * (~/.claude); the others live under the hub's home.
 *
 * What a person set up once is shared, not copied: a new profile's skills,
 * agents, commands, rules, output styles and plugins are junctions to the
 * default folder's, its CLAUDE.md a hard link, and the default settings.json
 * is merged into each session's --settings (sessions.ts). User-scope MCP
 * servers live in .claude.json beside the account, so they are not shared.
 *
 * Which account a new session uses: the one picked for it, else the
 * project's (Claude settings, "account"), else the hub's default.
 */

export const DEFAULT_PROFILE = "default";

globalDb.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config_dir  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

export interface Profile {
  id: string;
  name: string;
  configDir: string;
  /** The folder Claude Code uses on its own: not created or removed by the hub. */
  builtIn: boolean;
}

/** Shared with every profile, when the default folder has them. */
const SHARED_DIRS = ["skills", "agents", "commands", "rules", "output-styles", "plugins"];

let cache: Profile[] | null = null;

export function listProfiles(): Profile[] {
  cache ??= [
    { id: DEFAULT_PROFILE, name: "Default", configDir: claudeHome, builtIn: true },
    ...(globalDb.prepare("SELECT id, name, config_dir FROM profiles ORDER BY created_at").all() as Array<{ id: string; name: string; config_dir: string }>).map((row) => ({
      id: row.id,
      name: row.name,
      configDir: row.config_dir,
      builtIn: false,
    })),
  ];
  return cache;
}

// Transcripts are looked for in every profile's folder (paths.ts).
setExtraConfigDirs(() => listProfiles().filter((profile) => !profile.builtIn).map((profile) => profile.configDir));

export function getProfile(id: string | null | undefined): Profile | null {
  return listProfiles().find((profile) => profile.id === id) ?? null;
}

export function hubDefaultProfile(): string {
  const row = globalDb.prepare("SELECT value FROM hub_settings WHERE key = 'defaultProfile'").get() as { value: string } | undefined;
  return getProfile(row?.value) ? row!.value : DEFAULT_PROFILE;
}

export function setHubDefaultProfile(id: string): string {
  if (!getProfile(id)) throw new Error("No such account.");
  globalDb
    .prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES ('defaultProfile', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(id, now());
  return id;
}

/** In the current project: the account its new sessions use. */
export function projectProfile(): string {
  const own = claudeSettings().account;
  return own && getProfile(own) ? own : hubDefaultProfile();
}

/** The account whose folder holds a session's transcript; null before it has written one. */
export function profileOfSession(sessionId: string): string | null {
  const file = transcriptFile(sessionId);
  if (!fs.existsSync(file)) return null;
  // <config dir>/projects/<project slug>/<id>.jsonl
  const configDir = path.resolve(file, "..", "..", "..").toLowerCase();
  return listProfiles().find((profile) => path.resolve(profile.configDir).toLowerCase() === configDir)?.id ?? null;
}

/** What a session of this account is started with, on top of the hub's own environment. */
export function profileEnv(id: string): Record<string, string> {
  const profile = getProfile(id);
  return profile && !profile.builtIn ? { CLAUDE_CONFIG_DIR: profile.configDir } : {};
}

/** The default folder's settings.json, which another account's sessions take as their base. */
export function sharedSettings(id: string): Record<string, unknown> {
  const profile = getProfile(id);
  if (!profile || profile.builtIn) return {};
  try {
    const value = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "account";

/** Links what the default folder has into a new profile's folder; whatever cannot be linked is left out, not copied. */
function shareInto(dir: string): void {
  for (const name of SHARED_DIRS) {
    const source = path.join(claudeHome, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      // A junction needs no admin rights on Windows; elsewhere it is an ordinary symlink.
      fs.symlinkSync(source, target, "junction");
    } catch (error) {
      console.error(`[profiles] could not share ${name}: ${(error as Error).message}`);
    }
  }
  const memory = path.join(claudeHome, "CLAUDE.md");
  const target = path.join(dir, "CLAUDE.md");
  if (fs.existsSync(memory) && !fs.existsSync(target)) {
    try {
      fs.linkSync(memory, target);
    } catch {
      // Another drive, or links not allowed: the account goes without the user CLAUDE.md.
    }
  }
}

export function createProfile(name: string): Profile {
  const label = String(name ?? "").trim();
  if (!label) throw new Error("Give the account a name.");
  if (listProfiles().some((profile) => profile.name.toLowerCase() === label.toLowerCase())) throw new Error(`There is already an account named '${label}'.`);
  let id = slug(label);
  for (let n = 2; getProfile(id) || id === DEFAULT_PROFILE; n += 1) id = `${slug(label)}-${n}`;
  const dir = path.join(hubHome, "profiles", id);
  fs.mkdirSync(dir, { recursive: true });
  shareInto(dir);
  globalDb.prepare("INSERT INTO profiles (id, name, config_dir, created_at) VALUES (?, ?, ?, ?)").run(id, label, dir, now());
  cache = null;
  return getProfile(id)!;
}

export function renameProfile(id: string, name: string): Profile {
  const profile = getProfile(id);
  if (!profile || profile.builtIn) throw new Error("Only an added account can be renamed.");
  const label = String(name ?? "").trim();
  if (!label) throw new Error("Give the account a name.");
  globalDb.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(label, id);
  cache = null;
  return getProfile(id)!;
}

/** Drops an account from the hub. Its folder stays (sign-in, transcripts): the hub never deletes what Claude Code wrote. */
export function removeProfile(id: string): { folder: string } {
  const profile = getProfile(id);
  if (!profile || profile.builtIn) throw new Error("The default account cannot be removed.");
  globalDb.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  if (hubDefaultProfile() === id) setHubDefaultProfile(DEFAULT_PROFILE);
  cache = null;
  return { folder: profile.configDir };
}

const auth = new Map<string, { at: number; info: AuthInfo }>();

/** Who each account is signed in as, read with `claude auth status` and kept a few minutes. */
export async function profileAuth(id: string, fresh = false): Promise<AuthInfo | null> {
  const profile = getProfile(id);
  if (!profile) return null;
  const known = auth.get(id);
  if (!fresh && known && Date.now() - known.at < 5 * 60_000) return known.info;
  const info = await readAuth(profile.builtIn ? undefined : profile.configDir);
  auth.set(id, { at: Date.now(), info });
  return info;
}
