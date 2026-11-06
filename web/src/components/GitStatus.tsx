import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { projectApi } from "../lib/project";
import { useLive } from "../lib/store";

interface GitInfo {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  changed: number;
  untracked: number;
  conflicted: number;
  last: { hash: string; subject: string; at: string } | null;
}

const read = async (): Promise<GitInfo | null> => {
  const response = await fetch(`${projectApi()}/git`);
  const payload = (await response.json().catch(() => ({}))) as { git?: GitInfo | null; error?: string };
  if (!response.ok) throw new Error(payload.error ?? response.statusText);
  return payload.git ?? null;
};

/**
 * Where the project's checkout stands, in one small line at the foot of the
 * sidebar: branch, commits to push or pull, files changed. Read when files
 * move and every half minute; nothing when the project is not a git checkout.
 */
export function GitStatus() {
  const git = useLive(read, ["files", "runs"]);
  const { reload } = git;
  useEffect(() => {
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  const info = git.data;
  if (!info) return null;
  const changes = info.staged + info.changed + info.untracked;
  const title = [
    info.branch ? `Branch ${info.branch}` : "No branch",
    info.ahead !== null ? `${info.ahead} to push, ${info.behind} to pull` : "No upstream",
    `${info.staged} staged, ${info.changed} changed, ${info.untracked} untracked${info.conflicted ? `, ${info.conflicted} in conflict` : ""}`,
    info.last ? `Last commit ${info.last.hash} ${ago(info.last.at)}: ${info.last.subject}` : "No commit yet",
    "Click to read again",
  ].join("\n");

  return (
    <button
      onClick={reload}
      title={title}
      aria-label="Git status"
      className="group flex h-7 shrink-0 items-center gap-1.5 border-t px-3 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <GitBranch size={12} className="shrink-0" />
      <span className="min-w-0 truncate font-mono">{info.branch ?? "no branch"}</span>
      {info.ahead ? (
        <span className="flex shrink-0 items-center tabular-nums">
          <ArrowUp size={10} />
          {info.ahead}
        </span>
      ) : null}
      {info.behind ? (
        <span className="flex shrink-0 items-center tabular-nums">
          <ArrowDown size={10} />
          {info.behind}
        </span>
      ) : null}
      <span className="flex-1" />
      {info.conflicted > 0 && <span className="shrink-0 tabular-nums text-destructive">{info.conflicted} conflict{info.conflicted > 1 ? "s" : ""}</span>}
      <span className={cn("shrink-0 tabular-nums", changes ? "text-severity-warning" : "")}>{changes ? `${changes} changed` : "clean"}</span>
      <RefreshCw size={10} className="hidden shrink-0 group-hover:block" />
    </button>
  );
}
