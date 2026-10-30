import { ChevronDown, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useStore } from "../lib/store";
import { StatusDot } from "./Sidebar";

const FOLDED_KEY = "clauder-hub:running-dock-folded";

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The terminals running right now, in a small panel fixed to the bottom-right
 * corner of every page: one click to any of them. It folds into a pill, stays
 * folded across reloads, and is not there when nothing runs.
 */
export function RunningDock() {
  // Selected whole and filtered here: a selector returning a new array each time would loop.
  const sessions = useStore((state) => state.sessions);
  const live = sessions.filter((session) => session.live);
  const view = useStore((state) => state.view);
  const go = useStore((state) => state.go);
  const [folded, setFolded] = useState(readFolded);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, next ? "1" : "0");
    } catch {
      // The choice just does not persist.
    }
  };

  if (!live.length) return null;
  const waiting = live.filter((session) => session.status === "waiting").length;

  if (folded) {
    return (
      <button
        onClick={() => fold(false)}
        title="Running terminals"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs shadow-lg transition-colors hover:bg-muted"
      >
        <SquareTerminal size={13} className="text-success" />
        <span className="tabular-nums">{live.length}</span>
        {waiting > 0 && <span className="h-1.5 w-1.5 rounded-full bg-severity-warning" title={`${waiting} waiting on you`} />}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-64 overflow-hidden rounded-lg border bg-card shadow-lg">
      <button onClick={() => fold(true)} className="flex w-full items-center gap-1.5 border-b px-2.5 py-1.5 text-left text-[11px] font-medium hover:bg-muted/60" title="Fold">
        <SquareTerminal size={12} className="text-success" />
        Running
        <span className="tabular-nums text-muted-foreground">{live.length}</span>
        <ChevronDown size={12} className="ml-auto text-muted-foreground" />
      </button>
      <div className="max-h-56 overflow-y-auto py-0.5">
        {live.map((session) => {
          const active = view.kind === "session" && view.id === session.id;
          return (
            <button
              key={session.id}
              onClick={() => go({ kind: "session", id: session.id })}
              title={session.status === "waiting" ? `${session.title} (waiting on you)` : session.title}
              className={cn("flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
            >
              <StatusDot session={session} />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.openInteractions > 0 && <span className="grid h-4 min-w-[1rem] shrink-0 place-items-center rounded-full bg-severity-warning px-1 text-[10px] font-semibold leading-none text-background">{session.openInteractions}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
