import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The `claude` the user already runs, never a copy of our own. On Windows the
 * one on PATH is a `.cmd` shim, which a pty cannot exec directly, so the real
 * executable is looked up behind it.
 */
const BINARY = process.platform === "win32" ? "claude.exe" : "claude";

const KNOWN_LOCATIONS = [
  `${process.env.APPDATA ?? ""}/npm/node_modules/@anthropic-ai/claude-code/bin`,
  `${process.env.LOCALAPPDATA ?? ""}/npm/node_modules/@anthropic-ai/claude-code/bin`,
  `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.local/bin`,
  "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/usr/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/usr/local/bin",
];

function fromKnown(): string | null {
  for (const directory of KNOWN_LOCATIONS) {
    // An unset variable leaves "/npm/..." behind, which is nobody's install.
    if (directory.startsWith("/npm") || directory.startsWith("/.local")) continue;
    const candidate = path.join(directory, BINARY);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return null;
}

function fromNpmRoot(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true, windowsHide: true }).trim();
    const candidate = path.join(root, "@anthropic-ai", "claude-code", "bin", BINARY);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** A native install puts the real binary straight on PATH. */
function fromPath(): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const hits = execFileSync(finder, [BINARY], { encoding: "utf8", windowsHide: true }).split(/\r?\n/);
    return hits.map((hit) => hit.trim()).find((hit) => hit && fs.existsSync(hit)) ?? null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;

export function findClaudeCode(): string | null {
  if (cached !== undefined) return cached;
  cached = process.env.CLAUDER_HUB_CLAUDE ?? fromKnown() ?? fromPath() ?? fromNpmRoot();
  return cached;
}
