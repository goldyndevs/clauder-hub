import { useState } from "react";
import { api } from "./api";
import { attempt, useStore } from "./store";
import type { PurposeKind } from "./types";

/**
 * Opens a Claude session for one configuration purpose and goes straight to
 * its terminal; from a form, with what was filled in as the draft.
 */
export function usePurpose(): { starting: boolean; start: (kind: PurposeKind, targetId?: string, draft?: Record<string, unknown>) => Promise<void> } {
  const go = useStore((state) => state.go);
  const [starting, setStarting] = useState(false);
  const start = async (kind: PurposeKind, targetId?: string, draft?: Record<string, unknown>) => {
    if (starting) return;
    setStarting(true);
    // Roughly the terminal panel's size, so the TUI does not redraw at another width on attach.
    const cols = Math.max(80, Math.floor((window.innerWidth - 340) / 7.8));
    const rows = Math.max(24, Math.floor((window.innerHeight - 220) / 17));
    const started = await attempt(() => api.startPurpose(kind, targetId, { cols, rows }, draft));
    setStarting(false);
    if (!started) return;
    await useStore.getState().refreshSessions();
    go({ kind: "session", id: started.sessionId });
  };
  return { starting, start };
}
