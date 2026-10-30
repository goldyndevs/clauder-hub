import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeStatus, findClaudeCode } from "./claudeCode.js";
import { hubHome } from "./paths.js";

/**
 * One quick question to Claude, for understanding what a person typed in a
 * chat: which folder they mean, which session, which command. A small model
 * with no tools, no MCP and nothing kept, run in the hub's own folder so no
 * project's CLAUDE.md comes along; about five seconds. Null when Claude Code
 * is missing or does not answer, and the caller falls back on plain matching.
 */
export function askSmallModel(prompt: string, timeoutMs = 45_000): Promise<string | null> {
  const claude = findClaudeCode();
  if (!claude || claudeStatus()?.problem) return Promise.resolve(null);
  return new Promise((resolve) => {
    const cwd = path.join(hubHome, "global");
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(claude, ["-p", "--model", "haiku", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--output-format", "text"], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out : null);
    });
    child.stdin.end(prompt);
  });
}

/** The first JSON value of a kind in an answer, which may come wrapped in prose or a code fence. */
export function jsonIn<T>(answer: string | null, open: "[" | "{"): T | null {
  if (!answer) return null;
  const start = answer.indexOf(open);
  const end = answer.lastIndexOf(open === "[" ? "]" : "}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(answer.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Asks which of a numbered list fit a request; the numbers, best first, or null without an answer. */
export async function pickNumbers(prompt: string): Promise<number[] | null> {
  const picked = jsonIn<unknown[]>(await askSmallModel(prompt), "[");
  return picked ? picked.map(Number).filter((number) => Number.isInteger(number) && number > 0) : null;
}
