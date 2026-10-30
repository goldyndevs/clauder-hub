import { ArrowRight, Pencil, SquareTerminal, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";
import { useConfirm } from "./Confirm";
import { useSessionActions } from "./SessionActions";
import { StatusDot } from "./Sidebar";

function TabMenu({ x, y, items, onClose }: { x: number; y: number; items: Array<[string, typeof X, () => void, boolean?]>; onClose: () => void }) {
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
  return (
    <div
      role="menu"
      className="fixed z-50 w-44 rounded-lg border bg-card p-1 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 184), top: Math.min(y, window.innerHeight - 150) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map(([label, Icon, run, separated]) => (
        <button
          key={label}
          onClick={() => {
            onClose();
            run();
          }}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted", separated && "mt-1 border-t pt-2")}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The terminals running right now, as a tab strip above every page (the way
 * the open files are): a click goes to the session, the shown one carries the
 * orange top line, and closing a tab stops its terminal, after asking. The
 * strip is not there when nothing runs.
 */
export function TerminalTabs() {
  // Selected whole and filtered here: a selector returning a new array each time would loop.
  const sessions = useStore((state) => state.sessions);
  const view = useStore((state) => state.view);
  const go = useStore((state) => state.go);
  const confirm = useConfirm();
  const strip = useRef<HTMLDivElement>(null);
  const actions = useSessionActions();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const live = sessions.filter((session) => session.live);
  const active = view.kind === "session" ? view.id : null;

  useEffect(() => {
    if (!active) return;
    strip.current?.querySelector<HTMLElement>(`[data-session="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, live.length]);

  if (!live.length) return null;

  const stop = (session: Session) =>
    confirm({
      title: `Stop "${session.title}"?`,
      description: "The conversation is kept for a later resume.",
      confirmLabel: "Stop",
      tone: "destructive",
      run: () => api.killSession(session.id),
    });

  const stopAll = () =>
    confirm({
      title: `Stop all ${live.length} running terminal${live.length > 1 ? "s" : ""}?`,
      description: "Their conversations are kept for a later resume.",
      body: <div className="space-y-0.5 text-[11px] text-muted-foreground">{live.map((session) => <div key={session.id} className="truncate">{session.title}</div>)}</div>,
      confirmLabel: "Stop all",
      tone: "destructive",
      run: async () => {
        await Promise.all(live.map((session) => api.killSession(session.id)));
      },
    });

  return (
    <div ref={strip} className="no-scrollbar flex shrink-0 overflow-x-auto border-b bg-muted/30">
      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ["Open", ArrowRight, () => go({ kind: "session", id: menu.session.id })],
            ["Rename", Pencil, () => void actions.rename(menu.session)],
            ["Close", X, () => void stop(menu.session), true],
            ["Close All", XCircle, () => void stopAll()],
          ]}
        />
      )}
      <div className="flex shrink-0 items-center px-2 text-muted-foreground" title="Running terminals">
        <SquareTerminal size={13} />
      </div>
      {live.map((session) => {
        const isActive = session.id === active;
        return (
          <div
            key={session.id}
            data-session={session.id}
            title={session.status === "waiting" ? `${session.title} (waiting on you)` : session.title}
            onClick={() => go({ kind: "session", id: session.id })}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ session, x: event.clientX, y: event.clientY });
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                void stop(session);
              }
            }}
            className={cn(
              // Every tab keeps a 2px top border so the active one's orange line does not shift the row.
              "group flex max-w-[16rem] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-t-2 px-3 py-1.5 text-xs transition-colors",
              isActive ? "-mb-px border-t-primary bg-background text-foreground" : "border-t-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <StatusDot session={session} />
            <span className="truncate">{session.title}</span>
            {session.openInteractions > 0 && <span className="grid h-4 min-w-[1rem] shrink-0 place-items-center rounded-full bg-severity-warning px-1 text-[10px] font-semibold leading-none text-background">{session.openInteractions}</span>}
            <button
              aria-label={`Stop ${session.title}`}
              title="Stop this terminal"
              onClick={(event) => {
                event.stopPropagation();
                void stop(session);
              }}
              className={cn("grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-muted", !isActive && "invisible group-hover:visible")}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
