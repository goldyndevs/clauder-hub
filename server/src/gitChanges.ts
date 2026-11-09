import { execFile } from "node:child_process";
import path from "node:path";
import { FileError, resolvePath } from "./files.js";
import { projectRoot } from "./paths.js";

/**
 * The files git sees changed in the project's checkout, against HEAD, and a
 * file as HEAD has it, for the Files tab's "Changed" view and its side by
 * side diff. Read-only: git is asked, never told; paths go after "--" or in a
 * HEAD:<path> argument, never through a shell.
 */
export interface GitChange {
  /** Relative to the project, with "/". */
  path: string;
  /** M modified, A added, D deleted, R renamed, U untracked, C in conflict. */
  status: "M" | "A" | "D" | "R" | "U" | "C";
  /** A rename's old path, relative to the project (null when it was outside it). */
  from?: string | null;
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: projectRoot(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20_000, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr.toString() || error.message).trim().split("\n")[0]));
      else resolve(stdout.toString("utf8"));
    });
  });
}

/** Where the project sits inside its repository: "" at the top, "packages/web" in a monorepo. */
async function prefix(): Promise<string> {
  const top = (await git(["rev-parse", "--show-toplevel"])).trim();
  const relative = path.relative(path.resolve(top), path.resolve(projectRoot())).replace(/\\/g, "/");
  return relative === "" ? "" : relative;
}

/** A repository path as the project sees it; null when it is outside the project. */
const inProject = (repoPath: string, base: string): string | null => (base === "" ? repoPath : repoPath.startsWith(`${base}/`) ? repoPath.slice(base.length + 1) : null);

export async function gitChanges(): Promise<{ available: boolean; files: GitChange[] }> {
  let base: string;
  let out: string;
  try {
    base = await prefix();
    out = await git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  } catch {
    // Not a git checkout, or git is not installed.
    return { available: false, files: [] };
  }
  const files: GitChange[] = [];
  const records = out.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const kind = record[0];
    let repoPath: string;
    let status: GitChange["status"];
    let from: string | null | undefined;
    if (kind === "?") {
      repoPath = record.slice(2);
      status = "U";
    } else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = record.split(" ");
      const xy = parts[1];
      repoPath = parts.slice(8).join(" ");
      status = xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record.
      const parts = record.split(" ");
      repoPath = parts.slice(9).join(" ");
      status = "R";
      const original = records[index + 1] ?? "";
      index += 1;
      from = inProject(original, base);
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      repoPath = record.split(" ").slice(10).join(" ");
      status = "C";
    } else continue;
    const own = inProject(repoPath, base);
    if (own === null) continue;
    files.push({ path: own, status, ...(from !== undefined ? { from } : {}) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { available: true, files };
}

const MAX_BYTES = 2 * 1024 * 1024;

/** A file as HEAD has it; a rename is read under its old path. Empty and `exists: false` for a file HEAD does not have. */
export async function originalText(input: unknown, fromInput?: unknown): Promise<{ exists: boolean; content: string }> {
  resolvePath(input);
  const own = String(fromInput || input).replace(/\\/g, "/").replace(/^\/+/, "");
  if (fromInput) resolvePath(fromInput);
  const base = await prefix().catch(() => {
    throw new FileError("Not a git checkout.");
  });
  let content: string;
  try {
    content = await git(["show", `HEAD:${base ? `${base}/` : ""}${own}`]);
  } catch {
    return { exists: false, content: "" };
  }
  if (content.length > MAX_BYTES) throw new FileError("Too large to compare here.");
  if (content.includes("\0")) throw new FileError("A binary file; it is not compared as text.");
  return { exists: true, content };
}
