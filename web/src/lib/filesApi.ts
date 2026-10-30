/** The Files tab's slice of the API (/api/p/<project>/files), kept apart from api.ts. */
import { projectApi } from "./project";

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  ignored: boolean;
}

export type FileRead =
  | { path: string; kind: "text"; content: string; size: number; mtimeMs: number }
  | { path: string; kind: "binary" | "too-large"; size: number; mtimeMs: number };

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  summary: string;
  uncommitted: boolean;
}

export type Blame =
  | { available: true; path: string; head: string; you: string; commits: Record<string, BlameCommit>; lines: string[] }
  | { available: false; path: string; reason: string };

/** An error with the HTTP status, so a 409 (changed on disk) can be told apart. */
export class FilesError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${projectApi()}/files${url}`, { ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new FilesError(payload.error ?? response.statusText, response.status);
  return payload as T;
}

const send = <T>(method: string, url: string, body: unknown) => request<T>(url, { method, body: JSON.stringify(body) });

export const filesApi = {
  list: (path: string, ignored: boolean) => request<{ path: string; entries: FileEntry[] }>(`/list?path=${encodeURIComponent(path)}${ignored ? "&ignored=1" : ""}`),
  read: (path: string) => request<FileRead>(`/read?path=${encodeURIComponent(path)}`),
  /** Who last changed each line; available is false outside git or for an untracked file. */
  blame: (path: string) => request<Blame>(`/blame?path=${encodeURIComponent(path)}`),
  commit: (sha: string) => request<{ sha: string; message: string; author: string; email: string; date: string }>(`/commit?sha=${encodeURIComponent(sha)}`),
  /** When the file last changed, without its content; for noticing edits made elsewhere. */
  stat: (path: string) => request<{ path: string; exists: boolean; mtimeMs: number; size: number }>(`/stat?path=${encodeURIComponent(path)}`),
  /** Without expectedMtimeMs it overwrites whatever is on disk. */
  write: (path: string, content: string, expectedMtimeMs?: number) => send<{ path: string; size: number; mtimeMs: number }>("PUT", "/write", { path, content, expectedMtimeMs }),
  create: (path: string) => send<{ path: string }>("POST", "/create", { path }),
  mkdir: (path: string) => send<{ path: string }>("POST", "/mkdir", { path }),
  rename: (from: string, to: string) => send<{ path: string }>("POST", "/rename", { from, to }),
  remove: (path: string) => send<{ path: string }>("POST", "/delete", { path }),
  /** Pastes a copy into a folder; a taken name becomes "name copy". */
  /** Opens the system file manager with this file or folder selected. */
  reveal: (path: string) => send<{ path: string }>("POST", "/reveal", { path }),
  copy: (from: string, folder: string) => send<{ path: string }>("POST", "/copy", { from, folder }),
};

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
export const isHtml = (path: string) => /\.(html?|xhtml)$/i.test(path);

/** Shown as media rather than read as text. SVG is text but meant to be seen. */
export function mediaKind(path: string): "image" | "audio" | "video" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"].includes(ext)) return "audio";
  if (["mp4", "webm", "ogv", "mov", "m4v", "mkv"].includes(ext)) return "video";
  return null;
}

/** The file's bytes, path in the URL so an HTML page's relative links work. */
export const rawUrl = (path: string) => `${projectApi()}/files/raw/${path.split("/").map(encodeURIComponent).join("/")}`;
