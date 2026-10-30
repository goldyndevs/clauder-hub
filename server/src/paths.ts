import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentProject } from "./context.js";

/**
 * The project the current work belongs to (see context.ts): every session it
 * starts runs there, so Claude inherits that project's CLAUDE.md, rules,
 * skills and MCPs.
 */
export function projectRoot(): string {
  return currentProject().root;
}

/** Where the current project's session transcripts live. */
export function transcriptsDir(): string {
  return currentProject().transcriptsDir;
}

export const toolVersion: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/ in development, dist/ once built: the package root is above either.
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "";
  } catch {
    return "";
  }
})();

/** The hub's own home, one per machine: the project list, and each project's database. Never inside a project. */
export const hubHome = path.resolve(process.env.CLAUDER_HUB_HOME ?? path.join(os.homedir(), ".clauder-hub"));
export const projectsDir = path.join(hubHome, "projects");
/** Per-terminal settings and appended system prompts, handed to `claude` by path. */
export const runDir = path.join(hubHome, "run");

export function ensureLayout(): void {
  for (const dir of [hubHome, projectsDir, runDir]) fs.mkdirSync(dir, { recursive: true });
}

/** Claude Code's own home, which CLAUDE_CONFIG_DIR relocates. */
export const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

/** Claude Code names a project's transcript folder after its path, every non-alphanumeric as '-'. */
export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}
