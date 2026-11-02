import { ArrowUp, BellOff, ChevronRight, FolderGit2, FolderOpen, HardDrive, Home } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { GLOBAL_ID } from "../lib/project";
import { useLive, useStore } from "../lib/store";
import type { Folders } from "../lib/types";
import { showNotificationsSwitch } from "./ChannelsPage";
import { Logo } from "./Logo";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";

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
      <PausedBell />
    </span>
  );
}

/** Shown while this project's notifications are paused and it has a channel to pause; a click goes to the switch. */
function PausedBell() {
  const projectId = useStore((state) => state.projectId);
  const channels = useLive(() => api.channels(), ["channels"], projectId);
  if (!channels.data?.paused || !channels.data.channels.length) return null;
  return (
    <button
      onClick={showNotificationsSwitch}
      title="Notifications are paused on every channel. Click to turn them back on."
      aria-label="Notifications paused"
      className="self-center text-severity-warning hover:text-foreground"
    >
      <BellOff size={12} />
    </button>
  );
}

/** The chip beside the project's name: the other projects, a new folder, or the global page. */
export function ProjectSwitcher() {
  const projectId = useStore((state) => state.projectId);
  const openProject = useStore((state) => state.openProject);
  const projects = useLive(() => api.projects(), ["projects"]);
  // Other projects waiting on you show on the chip, so they are not missed.
  const waitingElsewhere = (projects.data ?? []).filter((project) => project.id !== projectId).reduce((total, project) => total + project.waiting, 0);

  // Back to the global home, where every project's card is and folders are opened.
  return (
    <button
      onClick={() => openProject(GLOBAL_ID)}
      className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Back to the global home: every project"
    >
      Change
      {waitingElsewhere > 0 && <span className="grid h-3.5 min-w-[0.875rem] place-items-center rounded-full bg-severity-warning px-1 text-[9px] font-semibold leading-none tabular-nums text-background">{waitingElsewhere}</span>}
    </button>
  );
}
