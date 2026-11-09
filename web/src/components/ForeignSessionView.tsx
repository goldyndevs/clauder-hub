import { ArrowRight, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { attempt, useLive, useStore } from "../lib/store";
import { useSessionActions } from "./SessionActions";
import { StatusDot } from "./Sidebar";
import { TerminalView } from "./TerminalView";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * A session of another project, shown here without switching to that
 * project: its terminal, what it is, stop or resume, and a way into its
 * project for the rest (activity, interactions, toolset). Everything it does
 * names the session's own project, never the one the sidebar shows.
 */
export function ForeignSessionView({ projectId, id }: { projectId: string; id: string }) {
  const sessions = useLive(() => api.sessionsIn(projectId), ["sessions"], projectId);
  const projects = useLive(() => api.projects(), ["projects"]);
  const switchToSession = useStore((state) => state.switchToSession);
  const actions = useSessionActions();
  const session = sessions.data?.find((item) => item.id === id) ?? null;
  const project = projects.data?.find((item) => item.id === projectId);
  const { reload } = sessions;

  // Another project's changes do not reach this page's event stream: read again every few seconds.
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === "visible" && reload(), 3000);
    return () => window.clearInterval(timer);
  }, [reload]);

  // As in its own project: opening a stopped session resumes it, once per visit.
  const [opening, setOpening] = useState<"idle" | "starting" | "failed">("idle");
  const decided = useRef(false);
  const resume = async () => {
    setOpening("starting");
    const started = await attempt(() => api.resumeSessionIn(projectId, id));
    setOpening(started ? "idle" : "failed");
    reload();
  };
  useEffect(() => {
    if (decided.current || !session) return;
    decided.current = true;
    if (!session.live) void resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (sessions.error) return <div className="p-6 text-xs text-severity-critical">{sessions.error}</div>;
  if (!sessions.data) return <div className="p-6 text-xs text-muted-foreground">Loading...</div>;
  if (!session) return <div className="p-6 text-xs text-muted-foreground">This session is no longer in {project?.name ?? projectId}.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot session={session} />
            <h1 className="truncate text-sm font-semibold">{session.title}</h1>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground [&>*]:shrink-0">
            <StatusBadge tone="on">{project?.name ?? projectId}</StatusBadge>
            <StatusBadge tone={session.status === "waiting" ? "warning" : session.status === "running" || session.status === "idle" ? "success" : session.status === "done" ? "on" : "off"}>{session.status}</StatusBadge>
            <span className="!shrink truncate">Another project's session; the sidebar stays on this one.</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {session.live ? (
            <Button variant="ghost" title="Stop" onClick={() => void actions.stop(session, projectId)}>
              <Square size={12} /> Stop
            </Button>
          ) : (
            <Button variant="ghost" disabled={opening === "starting"} onClick={() => void resume()}>
              <Play size={12} /> {opening === "starting" ? "Starting..." : "Resume"}
            </Button>
          )}
          <Button onClick={() => switchToSession(projectId, id)} title="Switch to its project, with its activity, interactions and toolset">
            Open in its project <ArrowRight size={12} />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 p-2 sm:p-3">
        {session.terminalId ? (
          <TerminalView key={session.terminalId} terminalId={session.terminalId} projectId={projectId} onExit={reload} />
        ) : (
          <div className="grid h-full place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">
            {opening === "starting" ? "Starting its terminal..." : opening === "failed" ? "It could not be resumed." : "Not running."}
          </div>
        )}
      </div>
    </div>
  );
}
