import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { attempt, useLive, useStore } from "../lib/store";
import { SessionHeader } from "./SessionView";
import { TerminalView } from "./TerminalView";
import { Button } from "./ui/Button";

/**
 * A session of another project, shown here without switching to that
 * project: its terminal, what it is, stop or resume, and a way into its
 * project for the rest (activity, interactions, toolset). Everything it does
 * names the session's own project, never the one the sidebar shows.
 */
export function ForeignSessionView({ projectId, id }: { projectId: string; id: string }) {
  const sessions = useLive(() => api.sessionsIn(projectId), ["sessions"], projectId);
  const switchToSession = useStore((state) => state.switchToSession);
  const session = sessions.data?.find((item) => item.id === id) ?? null;
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
  if (!session) return <div className="p-6 text-xs text-muted-foreground">This session is no longer in that project.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader
        session={session}
        projectId={projectId}
        resume={resume}
        resuming={opening === "starting"}
        onChanged={reload}
        extra={
          <Button onClick={() => switchToSession(projectId, id)} title="Switch to its project, with its activity, interactions and toolset" aria-label="Open in its project">
            <span className="hidden sm:inline">Its project</span> <ArrowRight size={12} />
          </Button>
        }
      />
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
