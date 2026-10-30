import { ArrowUp, ChevronRight, FolderGit2, FolderOpen, Globe, HardDrive, Home, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { GLOBAL_ID } from "../lib/project";
import { attempt, useLive, useStore } from "../lib/store";
import type { Folders, ProjectInfo } from "../lib/types";
import { useConfirm } from "./Confirm";
import { Logo } from "./Logo";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Popover } from "./ui/Popover";

/** What a project is doing now, as two small counts; nothing when it is idle. */
function Activity({ project }: { project: ProjectInfo }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {project.waiting > 0 && (
        <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-severity-warning px-1 text-[10px] font-semibold text-background" title={`${project.waiting} waiting for you`}>
          {project.waiting}
        </span>
      )}
      {project.running > 0 && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title={`${project.running} session${project.running === 1 ? "" : "s"} running`}>
          <span className="h-1.5 w-1.5 rounded-full bg-success" /> {project.running}
        </span>
      )}
    </span>
  );
}

/**
 * The folder picker: the hub runs on this machine, so it lists folders there.
 * A path can be pasted instead; a folder with .git is marked, as a likely project.
 */
export function OpenFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const openProject = useStore((state) => state.openProject);
  const [listing, setListing] = useState<Folders | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const browse = async (path?: string) => {
    try {
      const next = await api.folders(path);
      setListing(next);
      setTyped(next.path);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  useEffect(() => {
    if (open) void browse(listing?.path);
    // Opens where it was left last time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = async (path: string) => {
    setAdding(true);
    try {
      const project = await api.addProject(path);
      onOpenChange(false);
      openProject(project.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Open folder"
      description="Its sessions, jobs and channels run in the hub from now on."
      maxWidth="max-w-xl"
      height="h-[min(36rem,calc(100dvh-2rem))]"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!typed.trim() || adding} onClick={() => void add(typed.trim())}>
            {adding ? "Opening..." : "Open this folder"}
          </Button>
        </>
      }
    >
      {/* Fills the dialog's body, so only the folder list scrolls; the path and the buttons stay put. */}
      <div className="flex h-full min-h-0 flex-col gap-2">
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void browse(typed.trim());
          }}
        >
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="C:\Source code\your-repo" className="font-mono" />
          <Button type="submit" title="Go to this folder">
            <ChevronRight size={13} />
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" disabled={!listing?.parent} onClick={() => listing?.parent && void browse(listing.parent)} title="Up one folder">
            <ArrowUp size={12} /> Up
          </Button>
          <Button variant="ghost" onClick={() => void browse(listing?.home)}>
            <Home size={12} /> Home
          </Button>
          {(listing?.drives.length ?? 0) > 1 &&
            listing!.drives.map((drive) => (
              <Button key={drive} variant="ghost" onClick={() => void browse(drive)}>
                <HardDrive size={12} /> {drive}
              </Button>
            ))}
        </div>
        {error && <div className="text-xs text-severity-critical">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {listing?.folders.length ? (
            listing.folders.map((folder) => (
              <button
                key={folder.path}
                // One click goes in; Open this folder takes the one shown.
                onClick={() => void browse(folder.path)}
                onDoubleClick={() => void add(folder.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                title={folder.git ? "A git repository. Double-click to open it." : folder.path}
              >
                {folder.git ? <FolderGit2 size={13} className="shrink-0 text-primary" /> : <FolderOpen size={13} className="shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                {folder.git && <span className="shrink-0 text-[10px] text-muted-foreground">git</span>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-muted-foreground">{listing ? "No folders in here." : "Loading..."}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The recent projects, most recently opened first. Removing one only takes it off the hub. */
function ProjectList({ projects, current, onPick, compact = false }: { projects: ProjectInfo[]; current?: string | null; onPick: (id: string) => void; compact?: boolean }) {
  const confirm = useConfirm();
  const remove = (project: ProjectInfo) =>
    confirm({
      title: `Remove ${project.name} from the hub?`,
      description: "Its running sessions stop and its jobs no longer run. The folder and its saved settings stay.",
      confirmLabel: "Remove",
      tone: "destructive",
      run: async () => {
        await api.removeProject(project.id);
        if (project.id === current) useStore.getState().openProject(GLOBAL_ID);
      },
    });
  return (
    <div className="divide-y">
      {projects.map((project) => (
        <div key={project.id} className={cn("group flex items-center gap-2", compact ? "px-2 py-1.5" : "px-3 py-2.5", project.id === current && "bg-muted")}>
          <button disabled={!project.exists} onClick={() => onPick(project.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50" title={project.root}>
            <FolderGit2 size={compact ? 13 : 15} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate font-medium", compact ? "text-xs" : "text-sm")}>{project.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {project.exists ? project.root : `${project.root} (folder missing)`}
                {!compact && ` · opened ${ago(project.openedAt)}`}
              </span>
            </span>
            <Activity project={project} />
          </button>
          <button
            onClick={() => void remove(project)}
            title="Remove from the hub"
            aria-label={`Remove ${project.name}`}
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The logo in a header: a way back to #/global, every project at once. */
export function LogoLink({ className }: { className?: string }) {
  const openProject = useStore((state) => state.openProject);
  return (
    <button onClick={() => openProject(GLOBAL_ID)} title="Global: every project" aria-label="Go to Global" className={cn("shrink-0 rounded hover:opacity-80", className)}>
      <Logo size={20} />
    </button>
  );
}

/** "Clauder Hub" in a header, leading to #/global like the logo beside it. */
/** The hub's version, asked once for the whole page. */
let hubVersion: Promise<string | null> | null = null;

export function TitleLink() {
  const openProject = useStore((state) => state.openProject);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    hubVersion ??= api
      .hub()
      .then((hub) => hub.version ?? null)
      .catch(() => null);
    void hubVersion.then(setVersion);
  }, []);
  return (
    <span className="flex items-baseline gap-1.5">
      <button onClick={() => openProject(GLOBAL_ID)} title="Global: every project" className="text-left text-sm font-semibold leading-tight hover:underline">
        Clauder Hub
      </button>
      {version && <span className="text-[10px] font-normal leading-tight text-muted-foreground/70">v{version}</span>}
    </span>
  );
}

/** The chip beside the project's name: the other projects, a new folder, or the global page. */
export function ProjectSwitcher() {
  const projectId = useStore((state) => state.projectId);
  const openProject = useStore((state) => state.openProject);
  const projects = useLive(() => api.projects(), ["projects"]);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // Other projects waiting on you show on the chip, so they are not missed.
  const waitingElsewhere = (projects.data ?? []).filter((project) => project.id !== projectId).reduce((total, project) => total + project.waiting, 0);

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-1"
        trigger={
          <button className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Switch to another project">
            Change
            {waitingElsewhere > 0 && <span className="grid h-3.5 min-w-[0.875rem] place-items-center rounded-full bg-severity-warning px-1 text-[9px] font-semibold text-background">{waitingElsewhere}</span>}
          </button>
        }
      >
        <div className="max-h-80 overflow-y-auto">
          {projects.data && (
            <ProjectList
              compact
              projects={projects.data}
              current={projectId}
              onPick={(id) => {
                setOpen(false);
                if (id !== projectId) openProject(id);
              }}
            />
          )}
        </div>
        <div className="mt-1 flex gap-1 border-t pt-1">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => {
              setOpen(false);
              setPicking(true);
            }}
          >
            <Plus size={12} /> Open folder...
          </Button>
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => {
              setOpen(false);
              openProject(GLOBAL_ID);
            }}
          >
            <Globe size={12} /> Global
          </Button>
        </div>
      </Popover>
      <OpenFolderDialog open={picking} onOpenChange={setPicking} />
    </>
  );
}
