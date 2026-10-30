import { Copy, FolderOpen, X, XCircle } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { isDirty, useDrafts } from "../lib/fileDrafts";
import { useOpenFiles } from "../lib/openFiles";
import { filesApi } from "../lib/filesApi";
import { attempt, useStore } from "../lib/store";
import { useConfirm } from "./Confirm";

/**
 * Closes tabs the way VS Code does: unsaved ones ask first, and if the file on
 * screen was among them its neighbour takes its place (or the overview, when
 * no tab is left). Shared by the tab strip and anything else that closes tabs.
 */
export function useCloseTabs() {
  const confirm = useConfirm();
  return async (paths: string[]) => {
    if (!paths.length) return;
    const { drafts, drop } = useDrafts.getState();
    const unsaved = paths.filter((path) => isDirty(drafts[path]));
    if (unsaved.length) {
      const ok = await confirm({
        title: unsaved.length === 1 ? `Close ${unsaved[0].split("/").pop()} without saving?` : `Close ${unsaved.length} files without saving?`,
        description: "Their unsaved edits are lost.",
        body: unsaved.length > 1 ? <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">{unsaved.map((path) => <div key={path}>{path}</div>)}</div> : undefined,
        confirmLabel: "Discard and close",
        tone: "destructive",
      });
      if (!ok) return;
    }
    for (const path of paths) drop(path);
    const { view, go } = useStore.getState();
    const shown = view.kind === "file" ? view.path : null;
    const next = useOpenFiles.getState().close(paths, shown);
    if (shown && next !== shown) go(next ? { kind: "file", path: next } : { kind: "page", page: "overview" });
  };
}

function TabMenu({ path, x, y, onClose }: { path: string; x: number; y: number; onClose: () => void }) {
  const tabs = useOpenFiles((state) => state.tabs);
  const closeTabs = useCloseTabs();
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const index = tabs.findIndex((tab) => tab.path === path);
  const items: Array<[string, typeof X, () => void, boolean?]> = [
    ["Close", X, () => void closeTabs([path])],
    ["Close Others", XCircle, () => void closeTabs(tabs.filter((tab) => tab.path !== path).map((tab) => tab.path)), tabs.length < 2],
    ["Close to the Right", XCircle, () => void closeTabs(tabs.slice(index + 1).map((tab) => tab.path)), index === tabs.length - 1],
    ["Close All", XCircle, () => void closeTabs(tabs.map((tab) => tab.path))],
    ["Copy Relative Path", Copy, () => void navigator.clipboard?.writeText(path)],
    ["Reveal in File Explorer", FolderOpen, () => void attempt(() => filesApi.reveal(path))],
  ];
  return (
    <div
      role="menu"
      className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 230) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map(([label, Icon, run, disabled], n) => (
        <button
          key={label}
          disabled={disabled}
          onClick={() => {
            onClose();
            run();
          }}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40", n === 4 && "mt-1 border-t pt-2")}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The open files above the editor, as in VS Code: the preview tab in italics,
 * a dot for unsaved changes that becomes a close button on hover, middle-click
 * to close, double-click to keep a preview, drag to reorder, and a right-click
 * menu. Two files with the same name show their folder too. It sits above
 * every page, not only the file view, and goes away with the last tab; away
 * from a file no tab is active and a click goes back to it.
 */
export function FileTabs({ active }: { active: string | null }) {
  const tabs = useOpenFiles((state) => state.tabs);
  const { pin, reorder } = useOpenFiles.getState();
  const drafts = useDrafts((state) => state.drafts);
  const go = useStore((state) => state.go);
  const closeTabs = useCloseTabs();
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // The active tab scrolls into view when it is opened from the tree or a link.
  useEffect(() => {
    if (!active) return;
    strip.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  if (!tabs.length) return null;
  const names = tabs.map((tab) => tab.path.split("/").pop() ?? tab.path);

  return (
    <div ref={strip} className="no-scrollbar flex shrink-0 overflow-x-auto border-b bg-muted/30">
      {menu && <TabMenu {...menu} onClose={() => setMenu(null)} />}
      {tabs.map((tab, index) => {
        const name = names[index];
        const twin = names.filter((other) => other === name).length > 1;
        const folder = tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "";
        const dirty = isDirty(drafts[tab.path]);
        const isActive = tab.path === active;
        return (
          <div
            key={tab.path}
            data-path={tab.path}
            draggable
            title={tab.path}
            onClick={() => go({ kind: "file", path: tab.path })}
            onDoubleClick={() => pin(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                void closeTabs([tab.path]);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ path: tab.path, x: event.clientX, y: event.clientY });
            }}
            onDragStart={(event) => {
              setDragging(tab.path);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!dragging || dragging === tab.path) return;
              event.preventDefault();
              reorder(dragging, tab.path);
            }}
            onDragEnd={() => setDragging(null)}
            className={cn(
              // Every tab keeps a 2px top border so the active one's orange line does not shift the row.
              "group flex max-w-[16rem] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-t-2 px-3 py-1.5 text-xs transition-colors",
              isActive ? "-mb-px border-t-primary bg-background text-foreground" : "border-t-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              dragging === tab.path && "opacity-50",
            )}
          >
            <FileIcon name={name} size={13} />
            <span className={cn("truncate", tab.preview && "italic")}>{name}</span>
            {twin && folder && <span className="truncate text-[10px] text-muted-foreground">{folder}</span>}
            <button
              aria-label={`Close ${name}`}
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                void closeTabs([tab.path]);
              }}
              className={cn("grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-muted", !dirty && !isActive && "invisible group-hover:visible")}
            >
              {dirty ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-foreground group-hover:hidden" />
                  <X size={12} className="hidden group-hover:block" />
                </>
              ) : (
                <X size={12} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
