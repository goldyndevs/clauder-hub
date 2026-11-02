import { History, PanelRight, PanelRightClose, Plus } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { attempt, useLive, useStore } from "../lib/store";
import type { LiveProject, LiveSession } from "../lib/types";
import { Button } from "./ui/Button";
import { Popover } from "./ui/Popover";

const OPEN_KEY = "clauder-hub:live-panel";

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Whether the live panel shows, one choice for every project and the global page, remembered per browser. */
export const useLivePanel = create<{ open: boolean; toggle: () => void }>((set, get) => ({
  open: storedOpen(),
  toggle: () => {
    const open = !get().open;
    set({ open });
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // The choice just does not persist.
    }
  },
}));

/** The switch for the live panel, next to the hub's name. */
export function LivePanelToggle() {
  const { open, toggle } = useLivePanel();
  const Icon = open ? PanelRightClose : PanelRight;
  return (
    <button
      onClick={toggle}
      title={open ? "Hide the live sessions panel" : "Show the live sessions of every project, on the right"}
      aria-label={open ? "Hide live sessions" : "Show live sessions"}
      aria-pressed={open}
      className="self-center rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
    >
      <Icon size={13} />
    </button>
  );
}

function Dot({ status }: { status: LiveSession["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "waiting" ? "bg-severity-warning animate-status-pulse" : status === "running" ? "bg-success animate-status-pulse" : "bg-muted-foreground/40",
      )}
    />
  );
}

/**
 * Every project's live sessions, grouped by project, beside whatever page is
 * open: a click switches to the session (and its project), and each project
 * can start a new session or resume a recent one from here.
 */
export function LivePanel({ width }: { width: number }) {
  const toggle = useLivePanel((state) => state.toggle);
  const live = useLive(() => api.globalLive(), ["projects", "sessions", "interactions"]);
  const projects = live.data ?? [];
  const count = projects.reduce((total, project) => total + project.live.length, 0);

  return (
    <aside aria-label="Live sessions" style={{ width }} className="flex shrink-0 flex-col border-l bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-semibold">Live sessions</span>
        <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-muted px-1 text-[10px] font-semibold leading-none tabular-nums text-muted-foreground">{count}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={toggle} title="Hide this panel" aria-label="Hide live sessions">
          <PanelRightClose size={13} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {live.data && !projects.length && <p className="px-3 py-4 text-xs text-muted-foreground">Nothing is running in any project.</p>}
        {projects.map((project) => (
          <ProjectGroup key={project.id} project={project} />
        ))}
      </div>
    </aside>
  );
}

function ProjectGroup({ project }: { project: LiveProject }) {
  const projectId = useStore((state) => state.projectId);
  const view = useStore((state) => state.view);
  const openProject = useStore((state) => state.openProject);
  const openSessionIn = useStore((state) => state.openSessionIn);
  const [starting, setStarting] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const here = projectId === project.id;

  // Sized to the area the terminal will fill, so the TUI does not redraw at another width when the page attaches.
  const newSession = async () => {
    if (starting) return;
    setStarting(true);
    const main = document.querySelector("main");
    const cols = Math.max(80, Math.floor(((main?.clientWidth ?? window.innerWidth) - 40) / 7.8));
    const rows = Math.max(24, Math.floor((window.innerHeight - 140) / 17));
    const started = await attempt(() => api.startSessionIn(project.id, { cols, rows }));
    setStarting(false);
    if (!started) return;
    if (here) await useStore.getState().refreshSessions();
    openSessionIn(project.id, started.sessionId);
  };

  return (
    <div className="px-1.5 py-1">
      <div className="group flex items-center gap-1 px-1.5 py-1">
        <button
          onClick={() => openProject(project.id)}
          title={`Open ${project.name}`}
          className={cn("min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-wide hover:text-foreground", here ? "text-foreground" : "text-muted-foreground")}
        >
          {project.name}
        </button>
        <Popover
          open={resumeOpen}
          onOpenChange={setResumeOpen}
          align="end"
          className="w-64 p-1"
          trigger={
            <Button variant="ghost" size="icon" className="h-6 w-6" title={`Resume a session of ${project.name}`} aria-label="Resume a session" disabled={!project.recent.length}>
              <History size={12} />
            </Button>
          }
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Resume</div>
          {project.recent.map((session) => (
            <button
              key={session.id}
              onClick={() => {
                setResumeOpen(false);
                // Opening a session that is not running resumes it (SessionView).
                openSessionIn(project.id, session.id);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            >
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.lastAt && <span className="shrink-0 text-[10px] text-muted-foreground">{ago(session.lastAt)}</span>}
            </button>
          ))}
        </Popover>
        <Button variant="ghost" size="icon" className="h-6 w-6" title={`New session in ${project.name}`} aria-label="New session" disabled={starting} onClick={() => void newSession()}>
          <Plus size={12} />
        </Button>
      </div>
      {project.live.map((session) => {
        const current = here && view.kind === "session" && view.id === session.id;
        return (
          <button
            key={session.id}
            onClick={() => openSessionIn(project.id, session.id)}
            title={session.title}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", current ? "bg-primary/15 text-foreground" : "hover:bg-muted")}
          >
            <Dot status={session.status} />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {session.openInteractions > 0 && (
              <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-severity-warning px-1 text-[10px] font-semibold leading-none tabular-nums text-background">
                {session.openInteractions}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
