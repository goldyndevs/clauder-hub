import { Bell, BellOff, CalendarClock, ChevronsLeft, ChevronsRight, FolderGit2, Inbox, LayoutGrid, ListOrdered, Menu, Plus, Radio, Wrench, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { compact, when } from "../lib/format";
import { attempt, useLive, useStore, type Page } from "../lib/store";
import type { GlobalProject } from "../lib/types";
import { useMediaQuery } from "../lib/useMediaQuery";
import { usePersistentWidth } from "../lib/usePersistentWidth";
import { ChannelsPage } from "./ChannelsPage";
import { InteractionCard } from "./InteractionCard";
import { PageHeader } from "./Page";
import { useConfirm } from "./Confirm";
import { LogoLink, OpenFolderDialog, ProjectSwitcher, TitleLink } from "./Projects";
import { ResizeHandle } from "./ResizeHandle";
import { SessionView } from "./SessionView";
import { StatusDot } from "./Sidebar";
import { Button } from "./ui/Button";
import { Empty } from "./ui/Empty";
import { ClaudeBanner } from "./ClaudeBanner";
import { Tooltip } from "./ui/Tooltip";

/** #/global's pages: they reuse the project page names, so the route reads #/global/inbox. */
const GLOBAL_NAV: Array<{ page: Page; label: string; icon: typeof Inbox }> = [
  { page: "overview", label: "Projects", icon: LayoutGrid },
  { page: "inbox", label: "Inbox", icon: Inbox },
  { page: "channels", label: "Channels", icon: Radio },
];

/** One project at a glance: what runs, what waits, what comes next. A click opens it. */
function ProjectCard({ project }: { project: GlobalProject }) {
  const openProject = useStore((state) => state.openProject);
  const confirm = useConfirm();
  const toggleMute = () =>
    attempt(() => api.setMuted(project.id, !project.muted), project.muted ? `${project.name} is heard on the global channels again.` : `The global channels no longer hear from ${project.name}.`);
  const remove = () =>
    confirm({
      title: `Remove ${project.name} from the hub?`,
      description: "Its running sessions stop and its jobs no longer run. The folder and its saved settings stay.",
      confirmLabel: "Remove",
      tone: "destructive",
      run: async () => {
        await api.removeProject(project.id);
        useStore.getState().notify(`Removed ${project.name}. Opening its folder again brings it back as it was.`);
      },
    });
  return (
    <div className="card flex min-w-0 flex-col gap-2 p-3">
      <div className="flex items-start gap-2">
        <button onClick={() => openProject(project.id)} className="min-w-0 flex-1 text-left" title={project.root}>
          <div className="truncate text-sm font-semibold hover:underline">{project.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">{project.root}</div>
        </button>
        <button
          onClick={() => void toggleMute()}
          title={project.muted ? "Muted on the global channels: click to hear from it again" : "Heard on the global channels: click to mute"}
          aria-label={project.muted ? `Unmute ${project.name}` : `Mute ${project.name}`}
          className={cn("shrink-0 rounded p-1 hover:bg-muted", project.muted ? "text-muted-foreground" : "text-foreground")}
        >
          {project.muted ? <BellOff size={13} /> : <Bell size={13} />}
        </button>
        <button onClick={() => void remove()} title="Remove from the hub" aria-label={`Remove ${project.name}`} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X size={13} />
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span className={cn(project.waiting ? "font-semibold text-severity-warning" : "text-muted-foreground")}>⏳ {project.waiting} waiting</span>
        <span className="text-muted-foreground">▶️ {project.running} running</span>
        <span className="flex items-center gap-1 text-muted-foreground" title={project.runningRun ? `Running: ${project.runningRun}` : undefined}>
          <ListOrdered size={11} /> {project.runningRun ? "1 running, " : ""}
          {project.queued} queued
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 max-w-full items-center gap-1 truncate" title={project.nextCron ? `${project.nextCron.name}: ${when(project.nextCron.at)}` : undefined}>
          <CalendarClock size={11} className="shrink-0" /> <span className="truncate">{project.nextCron ? `${project.nextCron.name} · ${when(project.nextCron.at)}` : "no cron job"}</span>
        </span>
        <span title="Sent and written in the sessions active today, cache reads left out">
          {project.activeToday} active today · {compact(project.tokensToday)} tokens
        </span>
      </div>
    </div>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5">{children}</div>
    </div>
  );
}

/** #/global/overview: every project's card. */
function GlobalProjects() {
  const [picking, setPicking] = useState(false);
  const overview = useLive(() => api.globalOverview(), ["projects", "sessions", "interactions", "runs", "jobs", "channels"]);
  return (
    <Scroll>
      <PageHeader
        group="Global"
        title="Projects"
        description="Every project in the hub, most recently opened first. The bell says whether the global channels hear from it."
        action={
          <Button variant="primary" onClick={() => setPicking(true)}>
            <Plus size={12} /> Open folder...
          </Button>
        }
      />
      <OpenFolderDialog open={picking} onOpenChange={setPicking} />
      {overview.data?.length ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {overview.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <Empty variant="inline" title={overview.data ? "No projects yet." : "Loading..."} />
      )}
    </Scroll>
  );
}

/** #/global/inbox: everything waiting on a person, in every project, answered here. */
function GlobalInbox() {
  const inbox = useLive(() => api.globalInbox(), ["projects", "interactions"]);
  return (
    <Scroll>
      <PageHeader group="Global" title="Inbox" description="Everything waiting on you, in every project." />
      {inbox.data?.length ? (
        <div className="space-y-2">
          {inbox.data.map((item) => (
            <InteractionCard key={`${item.project.id}:${item.id}`} interaction={item} project={item.project} showSession />
          ))}
        </div>
      ) : (
        <Empty variant="inline" icon={Inbox} title={inbox.data ? "Nothing is waiting on you." : "Loading..."} />
      )}
    </Scroll>
  );
}

/**
 * The global sidebar: the global pages, every project to jump into, and the
 * hub tasks that set up global channels. Folds to icons, and becomes a drawer
 * on a narrow window, like a project's.
 */
function GlobalSidebar({ width, collapsed, onToggle, drawer = false }: { width: number | string; collapsed: boolean; onToggle: () => void; drawer?: boolean }) {
  const view = useStore((state) => state.view);
  const go = useStore((state) => state.go);
  const openProject = useStore((state) => state.openProject);
  const sessions = useStore((state) => state.sessions);
  const projects = useLive(() => api.projects(), ["projects"]);
  const [picking, setPicking] = useState(false);
  const inbox = useLive(() => api.globalInbox(), ["projects", "interactions"]);
  const waiting = inbox.data?.length ?? 0;
  const tasks = sessions.filter((session) => session.origin !== "external" || session.live).slice(0, 10);
  const isActive = (page: Page) => view.kind === "page" && (view.page === page || (page === "overview" && !GLOBAL_NAV.some((item) => item.page === view.page)));

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3">
        <LogoLink className="mb-2" />
        {GLOBAL_NAV.map((item) => (
          <Tooltip key={item.page} content={`Global · ${item.label}`} side="right" asChild>
            <Button variant="ghost" size="icon" className={cn(isActive(item.page) && "bg-muted text-foreground")} onClick={() => go({ kind: "page", page: item.page })}>
              <item.icon size={15} />
            </Button>
          </Tooltip>
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Expand sidebar">
          <ChevronsRight size={15} />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex shrink-0 flex-col" style={{ width }}>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <LogoLink />
        <div className="min-w-0">
          <TitleLink />
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] text-muted-foreground">Global</span>
            <ProjectSwitcher />
          </div>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={onToggle} aria-label={drawer ? "Close menu" : "Collapse sidebar"}>
          {drawer ? <X size={15} /> : <ChevronsLeft size={15} />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav className="px-2">
          {GLOBAL_NAV.map((item) => (
            <button
              key={item.page}
              onClick={() => go({ kind: "page", page: item.page })}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                isActive(item.page) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <item.icon size={14} />
              {item.label}
              {item.page === "inbox" && waiting > 0 && <span className="ml-auto rounded-full bg-severity-warning px-1.5 text-[10px] font-semibold text-background">{waiting}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-2 px-2">
          <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Projects
            <button onClick={() => setPicking(true)} title="Open folder..." aria-label="Add a project" className="ml-auto rounded p-0.5 hover:bg-muted hover:text-foreground">
              <Plus size={12} />
            </button>
          </div>
          {(projects.data ?? []).map((project) => (
            <button
              key={project.id}
              disabled={!project.exists}
              onClick={() => openProject(project.id)}
              title={project.root}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              <FolderGit2 size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.waiting > 0 && <span className="rounded-full bg-severity-warning px-1.5 text-[10px] font-semibold text-background">{project.waiting}</span>}
              {project.running > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-[10px]" title={`${project.running} running`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> {project.running}
                </span>
              )}
            </button>
          ))}
          {projects.data && !projects.data.length && <div className="px-2 py-1 text-[11px] text-muted-foreground">No projects yet.</div>}
        </div>

        {tasks.length > 0 && (
          <div className="mt-2 px-2">
            <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Hub tasks</div>
            {tasks.map((session) => (
              <button
                key={session.id}
                onClick={() => go({ kind: "session", id: session.id })}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  view.kind === "session" && view.id === session.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Wrench size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <StatusDot session={session} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t px-2 py-2">
        <Button variant="ghost" className="w-full justify-start" onClick={() => setPicking(true)}>
          <Plus size={13} /> Open folder...
        </Button>
        <OpenFolderDialog open={picking} onOpenChange={setPicking} />
      </div>
    </aside>
  );
}

const COLLAPSED_KEY = "clauder-hub:global-sidebar-collapsed";

/**
 * The frame #/global opens in: its own sidebar, and the global page or a hub
 * task's terminal (a global channel is set up in one).
 */
export function GlobalShell() {
  const view = useStore((state) => state.view);
  const left = usePersistentWidth("clauder-hub:sidebar-width", 280, { min: 220, max: 480 });
  const wide = useMediaQuery("(min-width: 768px)");
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.title = "Clauder Hub · Global";
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // The preference just does not persist.
    }
  }, [collapsed]);
  // Going anywhere closes the drawer, and so does growing past md.
  useEffect(() => setDrawer(false), [view, wide]);

  const content =
    view.kind === "session" ? (
      <SessionView key={view.id} id={view.id} />
    ) : view.kind === "page" && view.page === "inbox" ? (
      <GlobalInbox />
    ) : view.kind === "page" && view.page === "channels" ? (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-6xl p-5">
          <ChannelsPage global />
        </div>
      </div>
    ) : (
      <GlobalProjects />
    );

  return (
    <div className="flex h-screen overflow-hidden">
      {wide && <GlobalSidebar width={left.width} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />}
      {wide && !collapsed && <ResizeHandle onDrag={left.resizeBy} onReset={left.reset} />}
      {!wide && (
        <>
          {drawer && <div className="fixed inset-0 z-40 bg-foreground/40 animate-in fade-in-0" onClick={() => setDrawer(false)} />}
          <div inert={!drawer} className={cn("fixed inset-y-0 left-0 z-40 flex border-r bg-background transition-transform duration-200", drawer ? "translate-x-0 shadow-xl" : "-translate-x-full")}>
            <GlobalSidebar width="min(280px, 85vw)" collapsed={false} onToggle={() => setDrawer(false)} drawer />
          </div>
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
            <Button variant="ghost" size="icon" onClick={() => setDrawer(true)} aria-label="Open menu" title="Menu">
              <Menu size={16} />
            </Button>
            <LogoLink />
            <div className="min-w-0 flex-1">
              <TitleLink />
              <div className="text-[11px] text-muted-foreground">Global</div>
            </div>
          </div>
        )}
        <ClaudeBanner />
        <div className="min-h-0 flex-1">{content}</div>
      </main>
    </div>
  );
}
