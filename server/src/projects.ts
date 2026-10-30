import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { startChannels, stopChannels } from "./channels/index.js";
import { GLOBAL_ID, setContexts, withProject, type Project } from "./context.js";
import { globalDb, now, openProjectDb } from "./db.js";
import { broadcast } from "./events.js";
import { startInteractionSweeper } from "./interactions.js";
import { advance, recoverRuns, startScheduler, stopScheduler } from "./jobs.js";
import { claudeHome, hubHome, projectSlug, projectsDir } from "./paths.js";
import { killProjectTerminals, waitForExit } from "./terminals.js";
import { startTranscriptWatcher } from "./transcripts.js";

/**
 * The projects this hub manages. Each keeps its own database under the hub's
 * home and runs all the time once added: its cron jobs, webhooks, queue and
 * channels go on whichever project the dashboard is showing.
 */
interface Row {
  id: string;
  root: string;
  name: string;
  added_at: string;
  opened_at: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  openedAt: string;
  /** False when its folder is gone; it stays listed so it can be removed or comes back. */
  exists: boolean;
}

const live = new Map<string, { project: Project; stops: Array<() => void> }>();

const toInfo = (row: Row): ProjectInfo => ({ id: row.id, name: row.name, root: row.root, addedAt: row.added_at, openedAt: row.opened_at, exists: fs.existsSync(row.root) });

/** Most recently opened first, as VS Code lists recent folders. */
export function listProjects(): ProjectInfo[] {
  return (globalDb.prepare("SELECT * FROM projects ORDER BY opened_at DESC").all() as Row[]).map(toInfo);
}

/** A project by id, or the global context (/api/p/global serves the global channels and their hub tasks). */
export function getProject(id: string): Project | null {
  if (id === GLOBAL_ID) return global?.project ?? null;
  return live.get(id)?.project ?? null;
}

/** The projects only, not the global context. */
export function allProjects(): Project[] {
  return [...live.values()].map((entry) => entry.project);
}

let global: { project: Project; stops: Array<() => void> } | null = null;

export function globalProject(): Project {
  if (!global) throw new Error("The hub's global context has not started.");
  return global.project;
}

/**
 * Starts the global context: a folder of the hub's own, so its hub tasks have
 * somewhere to run, and a database for the global channels. Only channels run
 * in it (no queue, no cron), and no "this computer" channel: each project
 * already notifies the machine.
 */
export function bootGlobal(): Project {
  if (global) return global.project;
  const root = path.join(hubHome, GLOBAL_ID);
  fs.mkdirSync(root, { recursive: true });
  const project: Project = {
    id: GLOBAL_ID,
    name: "Global",
    root,
    transcriptsDir: path.join(claudeHome, "projects", projectSlug(root)),
    dataDir: root,
    db: openProjectDb(path.join(root, "hub.db")),
  };
  const stops = withProject(project, () => {
    recoverRuns();
    const list = [startTranscriptWatcher(), startInteractionSweeper(), stopChannels];
    startChannels({ device: false });
    return list;
  });
  global = { project, stops };
  setContexts(() => [...allProjects(), project]);
  return project;
}

/** Paths are compared the way the file system does: case-insensitively on Windows and macOS. */
const samePath = (a: string, b: string) => (process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase());

/** Each project's folder under the hub's home says whose it is, so a removed project's data never goes to another folder. */
const OWNER_FILE = "root.txt";
const ownerOf = (id: string) => {
  try {
    return fs.readFileSync(path.join(projectsDir, id, OWNER_FILE), "utf8").trim();
  } catch {
    return null;
  }
};
/** Route words the page reads before a project id (#/w/... is a window of its own). */
const RESERVED = new Set(["w", GLOBAL_ID]);

/**
 * The folder's name as an id, numbered when taken. An id whose data folder is
 * left from a removed project is free only to that same folder, which then
 * gets its jobs, channels and settings back.
 */
function freeId(name: string, root: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const taken = new Set((globalDb.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((row) => row.id));
  const free = (id: string) => {
    if (taken.has(id) || RESERVED.has(id)) return false;
    if (!fs.existsSync(path.join(projectsDir, id))) return true;
    const owner = ownerOf(id);
    return owner !== null && samePath(owner, root);
  };
  if (free(base)) return base;
  for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A project that ran under an older hub kept its database in
 * <project>/.clauder-hub/data. It is copied over once, the original left as it
 * was; the hub prompts it had rewritten become the hub's, unless already set.
 */
function importOldDatabase(root: string, file: string): void {
  const old = path.join(root, ".clauder-hub", "data", "hub.db");
  if (!fs.existsSync(old) || fs.existsSync(file)) return;
  const source = new Database(old, { readonly: true, fileMustExist: true });
  try {
    source.prepare("VACUUM INTO ?").run(file);
    const overrides = source.prepare("SELECT key, text, updated_at FROM prompt_overrides").all() as Array<{ key: string; text: string; updated_at: string }>;
    const insert = globalDb.prepare("INSERT OR IGNORE INTO prompt_overrides (key, text, updated_at) VALUES (?, ?, ?)");
    for (const row of overrides) insert.run(row.key, row.text, row.updated_at);
    console.log(`  imported : ${old}`);
  } catch (error) {
    // A half-written copy would be opened as the project's database from then on.
    fs.rmSync(file, { force: true });
    console.error(`[projects] could not import ${old}:`, (error as Error).message);
  } finally {
    source.close();
  }
}

/** Opens a project and starts what runs for it: transcripts, open questions, channels, cron and the queue. */
function boot(row: Row): Project {
  const running = live.get(row.id);
  if (running) return running.project;
  const dataDir = path.join(projectsDir, row.id);
  fs.mkdirSync(dataDir, { recursive: true });
  if (ownerOf(row.id) === null) fs.writeFileSync(path.join(dataDir, OWNER_FILE), row.root, "utf8");
  const file = path.join(dataDir, "hub.db");
  importOldDatabase(row.root, file);
  const project: Project = {
    id: row.id,
    name: row.name,
    root: row.root,
    transcriptsDir: path.join(claudeHome, "projects", projectSlug(row.root)),
    dataDir,
    db: openProjectDb(file),
  };
  const stops: Array<() => void> = [];
  try {
    withProject(project, () => {
      const stranded = recoverRuns();
      if (stranded) console.log(`  note    : ${row.name}: ${stranded} queued run(s) were running when the hub last stopped`);
      stops.push(startTranscriptWatcher(), startInteractionSweeper());
      stops.push(stopChannels);
      startChannels();
      stops.push(stopScheduler);
      startScheduler();
      advance();
    });
  } catch (error) {
    // Whatever had started stops again, or its timers would run on with no project to show for them.
    withProject(project, () => {
      for (const stop of stops) stop();
    });
    project.db.close();
    throw error;
  }
  live.set(row.id, { project, stops });
  return project;
}

/** Starts every known project whose folder is there, at hub start-up. */
export function bootProjects(): Project[] {
  for (const row of globalDb.prepare("SELECT * FROM projects").all() as Row[]) {
    if (!fs.existsSync(row.root)) continue;
    try {
      boot(row);
    } catch (error) {
      console.error(`[projects] could not start ${row.root}:`, (error as Error).message);
    }
  }
  return allProjects();
}

/** Adds a folder, or finds it when it is already known, and starts it. */
export function addProject(input: unknown): ProjectInfo {
  if (typeof input !== "string" || !input.trim()) throw new Error("Send the folder's full path.");
  const typed = path.resolve(input.trim());
  if (!fs.existsSync(typed) || !fs.statSync(typed).isDirectory()) throw new Error(`${typed} is not a folder.`);
  // As the disk spells it: Claude Code names a project's transcripts after the exact path, case included.
  const root = fs.realpathSync.native(typed);
  const rows = globalDb.prepare("SELECT * FROM projects").all() as Row[];
  let row = rows.find((item) => samePath(item.root, root));
  if (!row) {
    const name = path.basename(root) || root;
    row = { id: freeId(name, root), root, name, added_at: now(), opened_at: now() };
    boot(row);
    // Listed only once it runs, so a folder that cannot start is not left half added.
    globalDb.prepare("INSERT INTO projects (id, root, name, added_at, opened_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.root, row.name, row.added_at, row.opened_at);
  } else boot(row);
  broadcast("projects", {});
  return toInfo(globalDb.prepare("SELECT * FROM projects WHERE id = ?").get(row.id) as Row);
}

/** Marks a project as just opened, for the recent list. */
export function touchProject(id: string): void {
  globalDb.prepare("UPDATE projects SET opened_at = ? WHERE id = ?").run(now(), id);
  broadcast("projects", {});
}

/**
 * Stops everything a project runs and drops it from the list. Its folder and
 * its data under the hub's home stay. Its sessions are stopped and their exits
 * settled before its database closes.
 */
export async function removeProject(id: string): Promise<void> {
  const entry = live.get(id);
  if (entry) {
    live.delete(id);
    const terminals = withProject(entry.project, () => {
      for (const stop of entry.stops) stop();
      return killProjectTerminals(id);
    });
    await Promise.all(terminals.map((terminal) => waitForExit(terminal)));
    entry.project.db.close();
  }
  globalDb.prepare("DELETE FROM projects WHERE id = ?").run(id);
  broadcast("projects", {});
}

/** At shutdown: every project's schedules and channels stop, and its database closes. */
export function stopProjects(): void {
  for (const { project, stops } of [...live.values(), ...(global ? [global] : [])]) {
    withProject(project, () => {
      for (const stop of stops) stop();
    });
    project.db.close();
  }
  live.clear();
  global = null;
}
