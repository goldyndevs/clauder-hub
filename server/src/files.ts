import ignore, { type Ignore } from "ignore";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { broadcast } from "./events.js";
import { projectRoot } from "./paths.js";

/**
 * The project's own files, for the Files tab. Every path the page sends is
 * relative to the project root and checked to stay inside it, symlinks
 * included, before anything is read or written.
 */

/** Larger files, and anything with a NUL byte near its start, are not opened as text. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class FileError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function realRoot(): string {
  try {
    return fs.realpathSync(projectRoot());
  } catch {
    return projectRoot();
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The forward-slash form the page uses, "" for the root itself. */
function toRel(absolute: string): string {
  return path.relative(projectRoot(), absolute).split(path.sep).join("/");
}

/**
 * A page-supplied path, resolved under the project root. Absolute paths,
 * drive letters, ".." segments and NUL bytes are refused outright; then the
 * nearest existing ancestor's real path must still be inside the root, so a
 * symlink cannot lead out of it.
 */
export function resolvePath(input: unknown): string {
  if (typeof input !== "string") throw new FileError("A path is required.");
  const clean = input.replace(/\\/g, "/");
  if (clean.includes("\0")) throw new FileError("Invalid path.");
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) throw new FileError("Paths are relative to the project.");
  // On Windows any other ":" names an alternate data stream or another drive.
  if (process.platform === "win32" && clean.includes(":")) throw new FileError("Invalid path.");
  const segments = clean.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new FileError("Paths may not leave the project.");
  const absolute = path.resolve(projectRoot(), ...segments);
  if (!inside(projectRoot(), absolute)) throw new FileError("Paths may not leave the project.");

  let probe = absolute;
  while (!fs.existsSync(probe) && inside(projectRoot(), path.dirname(probe)) && probe !== projectRoot()) probe = path.dirname(probe);
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    // A dangling symlink: existsSync says no, but the link itself is there.
    throw new FileError("That path cannot be resolved.");
  }
  if (!inside(realRoot(), real)) throw new FileError("That path leads outside the project.");
  return absolute;
}

/** Nothing is written into git's own folder, at any depth. */
function refuseGit(absolute: string): void {
  if (toRel(absolute).split("/").includes(".git")) throw new FileError("The .git folder is not edited from here.");
}

function refuseRoot(absolute: string): void {
  if (absolute === projectRoot()) throw new FileError("The project folder itself cannot be changed.");
}

// .gitignore ----------------------------------------------------------------

const gitignores = new Map<string, { mtimeMs: number; rules: Ignore | null }>();

/** The parsed .gitignore of one folder, cached until the file changes. */
function rulesIn(dir: string): Ignore | null {
  const file = path.join(dir, ".gitignore");
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    gitignores.delete(file);
    return null;
  }
  const cached = gitignores.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.rules;
  let rules: Ignore | null = null;
  try {
    rules = ignore().add(fs.readFileSync(file, "utf8"));
  } catch {
    // An unreadable .gitignore ignores nothing.
  }
  gitignores.set(file, { mtimeMs, rules });
  return rules;
}

/**
 * Whether git would ignore `rel`, weighing every .gitignore from the root
 * down to its folder, deeper ones last so their negations win. The caller
 * already knows whether a parent folder is ignored, which nothing can undo.
 */
function ignoredBy(rel: string, isDir: boolean): boolean {
  const segments = rel.split("/");
  if (segments.includes(".git")) return true;
  let ignored = false;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const rules = rulesIn(path.join(projectRoot(), ...segments.slice(0, depth)));
    if (!rules) continue;
    const local = segments.slice(depth).join("/") + (isDir ? "/" : "");
    const result = rules.test(local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/** A folder is ignored if it, or any folder above it, is. */
function folderIgnored(rel: string): boolean {
  if (!rel) return false;
  const segments = rel.split("/");
  return segments.some((_, index) => ignoredBy(segments.slice(0, index + 1).join("/"), true));
}

// Reading -------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  ignored: boolean;
}

/** One folder's entries, folders first; ignored ones only when asked for. */
export function listFolder(relInput: unknown, showIgnored: boolean): { path: string; entries: FileEntry[] } {
  const absolute = resolvePath(relInput ?? "");
  const rel = toRel(absolute);
  const parentIgnored = folderIgnored(rel);
  if (parentIgnored && !showIgnored) return { path: rel, entries: [] };
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    throw new FileError("No such folder.", 404);
  }
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const full = path.join(absolute, dirent.name);
    let stat: fs.Stats;
    try {
      // A symlink is listed as what it points to, and only if that is inside the project.
      if (dirent.isSymbolicLink() && !inside(realRoot(), fs.realpathSync(full))) continue;
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const kind = stat.isDirectory() ? "dir" : "file";
    const entryRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    const ignored = parentIgnored || ignoredBy(entryRel, kind === "dir");
    if (ignored && !showIgnored) continue;
    entries.push({ name: dirent.name, path: entryRel, kind, size: kind === "file" ? stat.size : 0, ignored });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  return { path: rel, entries };
}

export type ReadResult =
  | { path: string; kind: "text"; content: string; size: number; mtimeMs: number }
  | { path: string; kind: "binary" | "too-large"; size: number; mtimeMs: number };

export function readText(relInput: unknown): ReadResult {
  const absolute = resolvePath(relInput);
  const rel = toRel(absolute);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new FileError("No such file.", 404);
  }
  if (!stat.isFile()) throw new FileError("That is not a file.");
  if (stat.size > MAX_TEXT_BYTES) return { path: rel, kind: "too-large", size: stat.size, mtimeMs: stat.mtimeMs };
  const bytes = fs.readFileSync(absolute);
  if (bytes.subarray(0, 8000).includes(0)) return { path: rel, kind: "binary", size: stat.size, mtimeMs: stat.mtimeMs };
  return { path: rel, kind: "text", content: bytes.toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Just when the file last changed, for an open editor to notice an edit made
 * elsewhere (a Claude session, another program) without reading the file.
 */
export function statFile(relInput: unknown): { path: string; exists: boolean; mtimeMs: number; size: number } {
  const absolute = resolvePath(relInput);
  const rel = toRel(absolute);
  try {
    const stat = fs.statSync(absolute);
    return { path: rel, exists: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { path: rel, exists: false, mtimeMs: 0, size: 0 };
  }
}

// Writing -------------------------------------------------------------------

function checkContent(content: unknown): string {
  if (typeof content !== "string") throw new FileError("Content must be text.");
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new FileError("That is more than 2 MB, which is not written from here.");
  return content;
}

function changed(...absolutes: string[]): void {
  broadcast("files", { paths: absolutes.map(toRel) });
}

/**
 * Saves an existing file. With `expectedMtimeMs`, a file changed on disk
 * since it was read (a session may have edited it) is refused with 409.
 */
export function writeText(relInput: unknown, contentInput: unknown, expectedMtimeMs?: unknown): { path: string; size: number; mtimeMs: number } {
  const absolute = resolvePath(relInput);
  refuseGit(absolute);
  const content = checkContent(contentInput);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new FileError("No such file.", 404);
  }
  if (!stat.isFile()) throw new FileError("That is not a file.");
  if (typeof expectedMtimeMs === "number" && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
    throw new FileError("The file changed on disk since it was opened.", 409);
  }
  fs.writeFileSync(absolute, content, "utf8");
  const after = fs.statSync(absolute);
  changed(absolute);
  return { path: toRel(absolute), size: after.size, mtimeMs: after.mtimeMs };
}

/** A new file; an existing one is never overwritten. The folder must exist. */
export function createFile(relInput: unknown, contentInput: unknown = ""): { path: string } {
  const absolute = resolvePath(relInput);
  refuseRoot(absolute);
  refuseGit(absolute);
  const content = checkContent(contentInput);
  if (!fs.existsSync(path.dirname(absolute))) throw new FileError("The folder does not exist.");
  try {
    fs.writeFileSync(absolute, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FileError("Something with that name already exists.", 409);
    throw error;
  }
  changed(absolute);
  return { path: toRel(absolute) };
}

export function createFolder(relInput: unknown): { path: string } {
  const absolute = resolvePath(relInput);
  refuseRoot(absolute);
  refuseGit(absolute);
  if (fs.existsSync(absolute)) throw new FileError("Something with that name already exists.", 409);
  if (!fs.existsSync(path.dirname(absolute))) throw new FileError("The folder does not exist.");
  fs.mkdirSync(absolute);
  changed(absolute);
  return { path: toRel(absolute) };
}

/** Renames or moves; the target must not exist, unless only the letter case differs. */
export function renamePath(fromInput: unknown, toInput: unknown): { path: string } {
  const from = resolvePath(fromInput);
  const to = resolvePath(toInput);
  for (const absolute of [from, to]) {
    refuseRoot(absolute);
    refuseGit(absolute);
  }
  if (!fs.existsSync(from)) throw new FileError("No such file or folder.", 404);
  // On a case-insensitive disk "a.ts" to "A.ts" finds the target already there: it is the same file.
  const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase() && fs.existsSync(to) && fs.statSync(from).ino === fs.statSync(to).ino;
  if (fs.existsSync(to) && !caseOnly) throw new FileError("Something with that name already exists.", 409);
  if (inside(from, to) && !caseOnly) throw new FileError("A folder cannot move into itself.");
  if (!fs.existsSync(path.dirname(to))) throw new FileError("The target folder does not exist.");
  fs.renameSync(from, to);
  changed(from, to);
  return { path: toRel(to) };
}

/**
 * Pastes a copy of a file or folder into a folder. A name already taken there
 * becomes "name copy.ext", then "name copy 2.ext", as VS Code names them.
 */
export function copyPath(fromInput: unknown, folderInput: unknown): { path: string } {
  const from = resolvePath(fromInput);
  const folder = resolvePath(folderInput ?? "");
  refuseRoot(from);
  refuseGit(folder);
  if (!fs.existsSync(from)) throw new FileError("No such file or folder.", 404);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new FileError("Paste into a folder.");
  if (inside(from, folder)) throw new FileError("A folder cannot be copied into itself.");
  const name = path.basename(from);
  const isDir = fs.statSync(from).isDirectory();
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let target = path.join(folder, name);
  for (let n = 1; fs.existsSync(target); n += 1) target = path.join(folder, `${stem} copy${n > 1 ? ` ${n}` : ""}${extension}`);
  fs.cpSync(from, target, { recursive: true, errorOnExist: true, force: false });
  changed(target);
  return { path: toRel(target) };
}

/**
 * Windows will not let a background process (the hub) put a window in front:
 * Explorer would open behind the browser. This opens it with the item
 * selected, finds that Explorer window by its folder, restores it and brings
 * it forward; the Alt tap is the documented way to be allowed to.
 */
const REVEAL_SCRIPT = `
Start-Process explorer.exe -ArgumentList ('/select,"' + $env:CLAUDER_REVEAL + '"')
Add-Type -Namespace Clauder -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
$shell = New-Object -ComObject Shell.Application
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 150
  $window = $shell.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $env:CLAUDER_REVEAL_DIR } catch { $false } } | Select-Object -First 1
  if ($window) {
    $handle = [System.IntPtr]$window.HWND
    [Clauder.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [Clauder.Win]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
    [Clauder.Win]::ShowWindow($handle, 9) | Out-Null
    [Clauder.Win]::SetForegroundWindow($handle) | Out-Null
    break
  }
}
`;

/**
 * Shows a file or folder in the operating system's file manager, selected, as
 * VS Code's "Reveal in File Explorer" does. The hub runs on the user's own
 * machine, so this opens a window there, in front. No shell string carries
 * the path: it is an argument, or (on Windows) an environment variable.
 */
export function revealPath(relInput: unknown): Promise<{ path: string }> {
  const absolute = resolvePath(relInput);
  if (!fs.existsSync(absolute)) throw new FileError("No such file or folder.", 404);
  // A Linux box without a desktop (a server reached over SSH) has no file manager to open.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new FileError("There is no desktop session on the machine running the hub, so no file manager to open.", 409);
  }
  const options = { windowsHide: false, detached: true, stdio: "ignore" as const };
  const child =
    process.platform === "win32"
      ? // The script opens Explorer and brings its window to the front (see REVEAL_SCRIPT); the
        // paths travel in the environment, never inside the command text. Not detached: a
        // detached PowerShell has no console and starts Explorer silently not at all (measured).
        spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", REVEAL_SCRIPT], {
          ...options,
          detached: false,
          windowsHide: true,
          env: { ...process.env, CLAUDER_REVEAL: absolute, CLAUDER_REVEAL_DIR: path.dirname(absolute) },
        })
      : process.platform === "darwin"
        ? spawn("open", ["-R", absolute], options)
        : spawn("xdg-open", [fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute)], options);
  // Explorer exits with 1 even when it worked, so only a launcher that cannot start counts as failing.
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new FileError(`Could not open the file manager: ${error.message}`, 409)));
    child.once("spawn", () => {
      child.unref();
      resolve({ path: toRel(absolute) });
    });
  });
}

/** Deletes a file, or a folder with everything in it. */
export function deletePath(relInput: unknown): { path: string } {
  const absolute = resolvePath(relInput);
  refuseRoot(absolute);
  refuseGit(absolute);
  // lstat: a symlink is removed itself, never what it points to.
  try {
    fs.lstatSync(absolute);
  } catch {
    throw new FileError("No such file or folder.", 404);
  }
  fs.rmSync(absolute, { recursive: true, force: false });
  changed(absolute);
  return { path: toRel(absolute) };
}
