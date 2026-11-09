import { useEffect } from "react";
import { create } from "zustand";
import { filesApi } from "./filesApi";
import { useLive } from "./store";

export interface GitChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "U" | "C";
  from?: string | null;
}

/** How often the list is read again while shown: a commit or an edit made outside the hub sends no event. */
const POLL_MS = 5000;

/**
 * The files git sees changed against HEAD: read again when files or sessions
 * move, when the window comes back, every few seconds while shown, and when
 * `extraKey` changes (the tree's Refresh).
 */
export function useGitChanges(extraKey: unknown = null) {
  const live = useLive(() => filesApi.changes(), ["files", "sessions"], extraKey);
  const { reload } = live;
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === "visible" && reload(), POLL_MS);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);
  return live;
}

export const STATUS_LABEL: Record<GitChange["status"], string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
  C: "In conflict",
};

export const STATUS_TONE: Record<GitChange["status"], string> = {
  M: "text-severity-warning",
  A: "text-success",
  U: "text-success",
  D: "text-severity-critical",
  C: "text-severity-critical",
  R: "text-primary",
};

/** The files shown as a diff rather than as the file: opened from the Changed view, or switched on in the file's header. */
export const useDiffMode = create<{ paths: Set<string>; set: (path: string, on: boolean) => void }>((set) => ({
  paths: new Set(),
  set: (path, on) =>
    set((state) => {
      const paths = new Set(state.paths);
      if (on) paths.add(path);
      else paths.delete(path);
      return { paths };
    }),
}));
