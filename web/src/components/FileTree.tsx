import { ArrowRight, ChevronDown, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, ExternalLink, File, FilePlus, Folder, FolderOpen, FolderPlus, Link, MoreHorizontal, Pencil, RefreshCw, Scissors, Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useFileClipboard } from "../lib/fileClipboard";
import { isDirty, useDrafts } from "../lib/fileDrafts";
import { tabsUnder, useOpenFiles } from "../lib/openFiles";
import { filesApi, type FileEntry } from "../lib/filesApi";
import { attempt, openWindow, useLive, useStore } from "../lib/store";
import { FileIcon } from "./FileIcon";
import { Button } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";

/**
 * The Files tab: the project's folders, read one folder at a time as they
 * open. What .gitignore ignores (and .git itself) is hidden unless "Show
 * ignored" is on. Creating, renaming, moving and deleting happen at once,
 * without a confirmation: the user asked for that here. Delete sits in the
 * row's menu (right click, long press or "...") so it is never one stray click.
 */

/** Per project: the folders open in its tree. */
const expandedKey = () => `clauder-hub:files-expanded:${useStore.getState().projectId}`;
const IGNORED_KEY = "clauder-hub:files-show-ignored";

type Editing = { kind: "file" | "folder"; parent: string } | { kind: "rename"; entry: FileEntry } | null;

interface TreeState {
  showIgnored: boolean;
  /** Bumped when the window regains focus, since a session may have changed files meanwhile. */
  epoch: number;
  expanded: Set<string>;
  toggle: (path: string, open?: boolean) => void;
  editing: Editing;
  setEditing: (editing: Editing) => void;
  openMenu: (entry: FileEntry, x: number, y: number) => void;
}

const Tree = createContext<TreeState | null>(null);
const useTree = () => useContext(Tree)!;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The preference just does not persist.
  }
}

const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");


/**
 * Pastes what was cut or copied into a folder: a copy gets a free name, a cut
 * moves it there (its drafts, tabs and the open view follow).
 */
async function pasteInto(folder: string, go: ReturnType<typeof useStore.getState>["go"], open: (path: string) => void): Promise<void> {
  const clip = useFileClipboard.getState().item;
  if (!clip) return;
  if (clip.mode === "copy") {
    const made = await attempt(() => filesApi.copy(clip.path, folder));
    if (made && folder) open(folder);
    return;
  }
  const name = clip.path.split("/").pop() ?? clip.path;
  const target = join(folder, name);
  if (target === clip.path) return useFileClipboard.getState().set(null);
  const moved = await attempt(() => filesApi.rename(clip.path, target));
  if (!moved) return;
  useFileClipboard.getState().set(null);
  useDrafts.getState().move(clip.path, moved.path);
  useOpenFiles.getState().rename(clip.path, moved.path);
  if (folder) open(folder);
  const view = useStore.getState().view;
  if (view.kind === "file" && (view.path === clip.path || view.path.startsWith(`${clip.path}/`))) go({ kind: "file", path: moved.path + view.path.slice(clip.path.length) });
}

export function FileTree() {
  const [showIgnored, setShowIgnored] = useState(() => readStored(IGNORED_KEY, false));
  const [expanded, setExpanded] = useState(() => new Set(readStored<string[]>(expandedKey(), [])));
  const [epoch, setEpoch] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  const clipboard = useFileClipboard((state) => state.item);
  const go = useStore((state) => state.go);

  useEffect(() => store(expandedKey(), [...expanded]), [expanded]);
  useEffect(() => {
    const onFocus = () => setEpoch((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const toggle = (path: string, open?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });

  const state: TreeState = { showIgnored, epoch, expanded, toggle, editing, setEditing, openMenu: (entry, x, y) => setMenu({ entry, x, y }) };
  const project = useStore((state) => state.health?.project ?? "Project");
  // A right click that no row took is on the project itself: its root menu.
  const onRootMenu = (event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setMenu({ entry: { name: project, path: "", kind: "dir", size: 0, ignored: false }, x: event.clientX, y: event.clientY });
  };

  return (
    <Tree.Provider value={state}>
      <div className="flex min-h-full flex-col" onContextMenu={onRootMenu}>
        {/* The toolbar stays put while the tree scrolls under it. */}
        <div className="sticky top-0 z-10 flex items-center gap-0.5 bg-background px-3 pb-1">
          <div className="flex-1 text-[10px] text-muted-foreground">Project files</div>
          <Tooltip content="New file" asChild>
            <Button variant="ghost" size="icon" aria-label="New file" onClick={() => setEditing({ kind: "file", parent: "" })}>
              <FilePlus size={13} />
            </Button>
          </Tooltip>
          <Tooltip content="New folder" asChild>
            <Button variant="ghost" size="icon" aria-label="New folder" onClick={() => setEditing({ kind: "folder", parent: "" })}>
              <FolderPlus size={13} />
            </Button>
          </Tooltip>
          <Tooltip content={showIgnored ? "Hide ignored" : "Show ignored"} asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Show ignored"
              aria-pressed={showIgnored}
              className={cn(showIgnored && "bg-muted text-foreground")}
              onClick={() => {
                setShowIgnored(!showIgnored);
                store(IGNORED_KEY, !showIgnored);
              }}
            >
              {showIgnored ? <Eye size={13} /> : <EyeOff size={13} />}
            </Button>
          </Tooltip>
          {clipboard && (
            <Tooltip content={`Paste ${clipboard.path.split("/").pop()} into the project root`} asChild>
              <Button variant="ghost" size="icon" aria-label="Paste into the project root" onClick={() => void pasteInto("", go, (path) => toggle(path, true))}>
                <ClipboardPaste size={13} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Refresh" asChild>
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => setEpoch(epoch + 1)}>
              <RefreshCw size={13} />
            </Button>
          </Tooltip>
        </div>
        {/* Grows to the bottom, so the empty space under the tree takes the root menu too. */}
        <div className="flex-1 px-2">
          <FolderChildren path="" depth={0} />
        </div>
      </div>
      {menu && <FileMenu {...menu} onClose={() => setMenu(null)} />}
    </Tree.Provider>
  );
}

function FolderChildren({ path, depth }: { path: string; depth: number }) {
  const { showIgnored, epoch, editing } = useTree();
  // A session that finishes has usually changed files, so "sessions" moves the tree too.
  const { data, error } = useLive(() => filesApi.list(path, showIgnored), ["files", "sessions"], [path, showIgnored, epoch]);
  const creating = editing && editing.kind !== "rename" && editing.parent === path ? editing.kind : null;
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  return (
    <>
      {creating && <NameInput depth={depth} icon={creating === "folder" ? Folder : File} initial="" />}
      {error && (
        <div className="py-1 text-[11px] text-severity-critical" style={indent}>
          {error}
        </div>
      )}
      {!data && !error && (
        <div className="py-1 text-[11px] text-muted-foreground" style={indent}>
          Loading...
        </div>
      )}
      {data && !data.entries.length && !creating && (
        <div className="py-1 text-[11px] text-muted-foreground" style={indent}>
          Empty
        </div>
      )}
      {data?.entries.map((entry) => <EntryRow key={entry.path} entry={entry} depth={depth} />)}
    </>
  );
}

function EntryRow({ entry, depth }: { entry: FileEntry; depth: number }) {
  const { expanded, toggle, editing, openMenu } = useTree();
  const go = useStore((state) => state.go);
  const active = useStore((state) => state.view.kind === "file" && state.view.path === entry.path);
  const dirty = useDrafts((state) => isDirty(state.drafts[entry.path]));
  const cut = useFileClipboard((state) => state.item?.mode === "cut" && state.item.path === entry.path);
  const open = entry.kind === "dir" && expanded.has(entry.path);
  // A touch held still for half a second opens the menu, and the click that follows does nothing.
  const press = useRef<{ timer?: number; fired: boolean }>({ fired: false });
  const endPress = () => window.clearTimeout(press.current.timer);

  if (editing?.kind === "rename" && editing.entry.path === entry.path) {
    return <NameInput depth={depth} icon={entry.kind === "dir" ? Folder : File} initial={entry.name} />;
  }

  return (
    <>
      <div className="relative">
        <button
          onClick={() => {
            if (press.current.fired) return;
            if (entry.kind === "dir") toggle(entry.path);
            else go({ kind: "file", path: entry.path });
          }}
          // A single click previews; a double click keeps the tab, as in VS Code.
          onDoubleClick={() => entry.kind === "file" && useOpenFiles.getState().pin(entry.path)}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(entry, event.clientX, event.clientY);
          }}
          onPointerDown={(event) => {
            press.current.fired = false;
            if (event.pointerType !== "touch") return;
            const { clientX: x, clientY: y } = event;
            window.clearTimeout(press.current.timer);
            press.current.timer = window.setTimeout(() => {
              press.current.fired = true;
              openMenu(entry, x, y);
            }, 500);
          }}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onPointerCancel={endPress}
          title={entry.path}
          className={cn(
            "flex w-full select-none items-center gap-1.5 rounded-md py-1 pr-8 text-left text-xs transition-colors [-webkit-touch-callout:none] md:pr-2",
            active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            entry.ignored && "opacity-55",
            cut && "opacity-45",
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {entry.kind === "dir" ? open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" /> : <span className="w-[11px] shrink-0" />}
          <FileIcon name={entry.name} folder={entry.kind === "dir"} open={open} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {dirty && <span title="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-severity-warning" />}
        </button>
        {/* Touch has no right click: the same menu from a button of its own, shown only in the drawer. */}
        <button
          aria-label="File actions"
          title="File actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(entry, rect.right - 192, rect.bottom + 4);
          }}
          className="absolute right-1 top-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
      {open && <FolderChildren path={entry.path} depth={depth + 1} />}
    </>
  );
}

/**
 * The inline name field for a new file or folder, or a rename. A rename only
 * renames, in the same folder; moving is Cut and Paste. A new file or folder
 * may be given a path ("src/new.ts") to create its folders on the way. Enter
 * applies, Escape or leaving the field cancels.
 */
function NameInput({ depth, icon: Icon, initial }: { depth: number; icon: typeof File; initial: string }) {
  const { editing, setEditing, toggle } = useTree();
  const go = useStore((state) => state.go);
  const [name, setName] = useState(initial);
  const busy = useRef(false);

  const submit = async () => {
    const typed = name.trim();
    if (busy.current) return;
    if (!editing || !typed) return setEditing(null);
    if (editing.kind === "rename" && /[\\/]/.test(typed)) {
      useStore.getState().notify("A name cannot contain / or \\. To move it, use Cut and Paste.", "error");
      return;
    }
    const parent = editing.kind === "rename" ? parentOf(editing.entry.path) : editing.parent;
    const target = typed.startsWith("/") ? typed.replace(/^\/+/, "") : join(parent, typed);
    busy.current = true;
    if (editing.kind === "rename") {
      const from = editing.entry.path;
      if (target === from) return setEditing(null);
      const moved = await attempt(() => filesApi.rename(from, target));
      busy.current = false;
      if (!moved) return;
      useDrafts.getState().move(from, moved.path);
      useOpenFiles.getState().rename(from, moved.path);
      const view = useStore.getState().view;
      if (view.kind === "file" && (view.path === from || view.path.startsWith(`${from}/`))) go({ kind: "file", path: moved.path + view.path.slice(from.length) });
    } else {
      const made = await attempt(() => (editing.kind === "folder" ? filesApi.mkdir(target) : filesApi.create(target)));
      busy.current = false;
      if (!made) return;
      if (editing.kind === "file") go({ kind: "file", path: made.path });
      else toggle(made.path, true);
    }
    setEditing(null);
  };

  return (
    <div className="flex items-center gap-1.5 py-0.5 pr-2" style={{ paddingLeft: `${depth * 12 + 19}px` }}>
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onFocus={(event) => {
          // Select the name without its extension, the part one usually renames.
          const dot = initial.lastIndexOf(".");
          event.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          if (event.key === "Escape") setEditing(null);
        }}
        onBlur={() => !busy.current && setEditing(null)}
        placeholder={editing?.kind === "folder" ? "Folder name" : "File name"}
        spellCheck={false}
        className="min-w-0 flex-1 rounded border border-primary/60 bg-background px-1.5 py-0.5 text-xs focus:outline-none"
      />
    </div>
  );
}

/** The right-click menu on a file or folder (on touch, a long press or the row's "..." button), or on the project root, path "". */
function FileMenu({ entry, x, y, onClose }: { entry: FileEntry; x: number; y: number; onClose: () => void }) {
  const { setEditing, toggle } = useTree();
  const go = useStore((state) => state.go);
  const root = useStore((state) => state.health?.projectRoot ?? "");
  const clipboard = useFileClipboard((state) => state.item);
  // Absolute paths use the machine's own separator, as an editor or a terminal expects them.
  const windows = root.includes("\\");
  const isRoot = entry.path === "";
  const absolute = isRoot ? root : root ? (windows ? `${root}\\${entry.path.replace(/\//g, "\\")}` : `${root}/${entry.path}`) : entry.path;
  const copyText = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => useStore.getState().notify(`Copied the ${what}.`),
      () => useStore.getState().notify("The browser did not allow copying.", "error"),
    );

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const remove = async () => {
    const removed = await attempt(() => filesApi.remove(entry.path), `Deleted ${entry.name}.`);
    if (!removed) return;
    const { drafts, drop } = useDrafts.getState();
    for (const path of Object.keys(drafts)) if (path === entry.path || path.startsWith(`${entry.path}/`)) drop(path);
    // The file is gone, so its tabs close without asking; the shown one hands over to a neighbour.
    const view = useStore.getState().view;
    const shown = view.kind === "file" ? view.path : null;
    const next = useOpenFiles.getState().close(tabsUnder(entry.path), shown);
    if (shown && next !== shown) go(next ? { kind: "file", path: next } : { kind: "page", page: "overview" });
    else if (view.kind === "file" && (view.path === entry.path || view.path.startsWith(`${entry.path}/`))) go({ kind: "page", page: "overview" });
  };

  const item = (label: string, icon: typeof File, run: () => void, danger = false) => {
    const Icon = icon;
    return (
      <button
        // Pointer-down closes the menu, before the window listener. The action waits for the
        // press to finish, or the focus it moves would blur a name field the action just opened.
        onPointerDown={(event) => {
          event.stopPropagation();
          onClose();
          window.setTimeout(run);
        }}
        className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs", danger ? "text-severity-critical hover:bg-destructive/15" : "hover:bg-muted")}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  // A new entry inside a folder opens that folder first, so its field is visible.
  const newIn = (kind: "file" | "folder") => () => {
    toggle(entry.path, true);
    setEditing({ kind, parent: entry.path });
  };

  if (isRoot) {
    return (
      <div
        role="menu"
        className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
        style={{ left: Math.min(x, window.innerWidth - 200), top: Math.max(8, Math.min(y, window.innerHeight - 220)) }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {item("New file", FilePlus, () => setEditing({ kind: "file", parent: "" }))}
        {item("New folder", FolderPlus, () => setEditing({ kind: "folder", parent: "" }))}
        {clipboard && item("Paste", ClipboardPaste, () => void pasteInto("", go, (path) => toggle(path, true)))}
        <div className="my-1 border-t" />
        {item("Copy Path", Link, () => copyText(absolute, "path"))}
        {item("Reveal in File Explorer", FolderOpen, () => void attempt(() => filesApi.reveal("")))}
      </div>
    );
  }

  return (
    <div
      role="menu"
      className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
      // Kept inside the window when opened near its bottom or right edge.
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.max(8, Math.min(y, window.innerHeight - 380)) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {entry.kind === "file" ? (
        <>
          {item("Open", ArrowRight, () => go({ kind: "file", path: entry.path }))}
          {item("Open in new window", ExternalLink, () => openWindow({ kind: "file", path: entry.path }))}
        </>
      ) : (
        <>
          {item("New file", FilePlus, newIn("file"))}
          {item("New folder", FolderPlus, newIn("folder"))}
        </>
      )}
      <div className="my-1 border-t" />
      {item("Cut", Scissors, () => useFileClipboard.getState().set({ mode: "cut", path: entry.path }))}
      {item("Copy", Copy, () => useFileClipboard.getState().set({ mode: "copy", path: entry.path }))}
      {clipboard && item(`Paste${entry.kind === "dir" ? " into folder" : " here"}`, ClipboardPaste, () => void pasteInto(entry.kind === "dir" ? entry.path : parentOf(entry.path), go, (path) => toggle(path, true)))}
      <div className="my-1 border-t" />
      {item("Copy Path", Link, () => copyText(absolute, "path"))}
      {item("Copy Relative Path", Link, () => copyText(entry.path, "relative path"))}
      {item("Reveal in File Explorer", FolderOpen, () => void attempt(() => filesApi.reveal(entry.path)))}
      <div className="my-1 border-t" />
      {item("Rename", Pencil, () => setEditing({ kind: "rename", entry }))}
      <div className="my-1 border-t" />
      {item("Delete", Trash2, () => void remove(), true)}
    </div>
  );
}
