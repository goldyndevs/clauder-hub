import { create } from "zustand";

/**
 * Unsaved edits from the Files tab, per file, kept in memory while the page
 * lives: going to another view and back finds the draft where it was left.
 * `base` and `mtimeMs` are what was read, so saving can tell whether the
 * file changed on disk meanwhile.
 */
export interface Draft {
  text: string;
  base: string;
  mtimeMs: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  put: (path: string, draft: Draft) => void;
  drop: (path: string) => void;
  /** Follows a rename or move, the folder's drafts included. */
  move: (from: string, to: string) => void;
}

export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  put: (path, draft) => set((state) => ({ drafts: { ...state.drafts, [path]: draft } })),
  drop: (path) =>
    set((state) => {
      const { [path]: _gone, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  move: (from, to) =>
    set((state) => ({
      drafts: Object.fromEntries(
        Object.entries(state.drafts).map(([path, draft]) => [path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path, draft]),
      ),
    })),
}));

export const isDirty = (draft: Draft | undefined) => Boolean(draft && draft.text !== draft.base);

/** Other projects' drafts, set aside while another project is shown; paths are per project. */
const parked = new Map<string, Record<string, Draft>>();
let parkedFor: string | null = null;

/** Puts the shown project's drafts aside and brings back the next one's. */
export function swapDrafts(projectId: string | null): void {
  if (projectId === parkedFor) return;
  if (parkedFor) parked.set(parkedFor, useDrafts.getState().drafts);
  useDrafts.setState({ drafts: (projectId && parked.get(projectId)) || {} });
  if (projectId) parked.delete(projectId);
  parkedFor = projectId;
}

// Closing or reloading the tab would lose them, in any project: the browser asks first.
window.addEventListener("beforeunload", (event) => {
  const all = [useDrafts.getState().drafts, ...parked.values()];
  if (all.some((drafts) => Object.values(drafts).some(isDirty))) event.preventDefault();
});

const AUTO_SAVE_KEY = "clauder-hub:auto-save";

/** Auto save, one switch for every file, remembered in this browser. */
export const useAutoSave = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem(AUTO_SAVE_KEY) === "1";
    } catch {
      return false;
    }
  })(),
  set: (on) => {
    try {
      localStorage.setItem(AUTO_SAVE_KEY, on ? "1" : "0");
    } catch {
      // It still applies until the page reloads.
    }
    set({ on });
  },
}));
