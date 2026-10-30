import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

/**
 * The hub manages several projects at once, each with its own database,
 * sessions, jobs and channels. Work for a project runs inside its context:
 * a request under /api/p/<id>, a hook from one of its terminals, a cron tick,
 * a channel reply. `db`, `projectRoot()` and `transcriptsDir()` read it, so
 * the code that does the work never passes a project around.
 */
export interface Project {
  /** Short and readable, from the folder name: it is the dashboard's route, #/<id>/... */
  id: string;
  name: string;
  root: string;
  /** Where Claude Code keeps this project's transcripts. */
  transcriptsDir: string;
  /** This project's own folder under the hub's home: its database. */
  dataDir: string;
  db: Database.Database;
}

const storage = new AsyncLocalStorage<Project>();

export function withProject<T>(project: Project, run: () => T): T {
  return storage.run(project, run);
}

/** The project the current work belongs to. Missing means a code path forgot to enter one: a bug, said loudly. */
export function currentProject(): Project {
  const project = storage.getStore();
  if (!project) throw new Error("No project in this context.");
  return project;
}

export function maybeProject(): Project | undefined {
  return storage.getStore();
}

/** Runs later work (a callback from a socket, a timer, a child process) in the project that set it up. */
export function bindProject<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const project = currentProject();
  return (...args: A) => withProject(project, () => fn(...args));
}

/**
 * The hub's own context, beside the projects: the global channels (one bot for
 * every project) and the hub tasks that set them up live in it, in a folder of
 * the hub's home. It is never listed as a project.
 */
export const GLOBAL_ID = "global";
export const isGlobal = (project: Project) => project.id === GLOBAL_ID;

let contexts: () => Project[] = () => [];
/** Set by projects.ts: every running project and the global context, for checks that span them. */
export function setContexts(list: () => Project[]): void {
  contexts = list;
}
export function allContexts(): Project[] {
  return contexts();
}
