import { create } from "zustand";

/**
 * The editor tabs, the way VS Code keeps them: a single-click opens a file in
 * the preview tab (italic), which the next single-click reuses; a double-click
 * or the first edit pins it. The order is the user's, and survives a reload.
 */
export interface OpenFile {
  path: string;
  preview: boolean;
}

/** Each project keeps its own tabs. */
let key: string | null = null;

function load(): OpenFile[] {
  if (!key) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter((item) => typeof item?.path === "string").map((item) => ({ path: item.path, preview: Boolean(item.preview) })) : [];
  } catch {
    return [];
  }
}

function save(tabs: OpenFile[]): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(tabs));
  } catch {
    // The tabs just do not survive a reload.
  }
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

interface OpenFilesState {
  tabs: OpenFile[];
  /** Shows a file: an open tab stays as it is, a new one replaces the preview tab, or opens as one. */
  show: (path: string) => void;
  pin: (path: string) => void;
  /** Closes tabs; returns the tab to show instead when the shown one was among them. */
  close: (paths: string[], shown: string | null) => string | null;
  /** Moves a tab to sit where another one is. */
  reorder: (from: string, to: string) => void;
  /** Follows a rename or move, a folder's files included. */
  rename: (from: string, to: string) => void;
}

export const useOpenFiles = create<OpenFilesState>((set, get) => {
  const update = (tabs: OpenFile[]) => {
    save(tabs);
    set({ tabs });
  };
  return {
    tabs: load(),
    show: (path) => {
      const tabs = get().tabs;
      if (tabs.some((tab) => tab.path === path)) return;
      const preview = tabs.findIndex((tab) => tab.preview);
      if (preview === -1) return update([...tabs, { path, preview: true }]);
      update(tabs.map((tab, index) => (index === preview ? { path, preview: true } : tab)));
    },
    pin: (path) => {
      const tabs = get().tabs;
      if (!tabs.some((tab) => tab.path === path && tab.preview)) {
        if (!tabs.some((tab) => tab.path === path)) update([...tabs, { path, preview: false }]);
        return;
      }
      update(tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)));
    },
    close: (paths, shown) => {
      const tabs = get().tabs;
      const closing = new Set(paths);
      const kept = tabs.filter((tab) => !closing.has(tab.path));
      update(kept);
      if (!shown || !closing.has(shown)) return shown;
      // The neighbour VS Code would pick: the next one to the right, else to the left.
      const index = tabs.findIndex((tab) => tab.path === shown);
      const after = tabs.slice(index + 1).find((tab) => !closing.has(tab.path));
      const before = tabs.slice(0, index).reverse().find((tab) => !closing.has(tab.path));
      return (after ?? before)?.path ?? null;
    },
    reorder: (from, to) => {
      const tabs = [...get().tabs];
      const source = tabs.findIndex((tab) => tab.path === from);
      const target = tabs.findIndex((tab) => tab.path === to);
      if (source === -1 || target === -1 || source === target) return;
      const [moved] = tabs.splice(source, 1);
      tabs.splice(target, 0, moved);
      update(tabs);
    },
    rename: (from, to) => update(get().tabs.map((tab) => (under(tab.path, from) ? { ...tab, path: to + tab.path.slice(from.length) } : tab))),
  };
});

/** Shows another project's tabs, as they were left there. */
export function loadOpenFiles(projectId: string | null): void {
  key = projectId ? `clauder-hub:open-files:${projectId}` : null;
  useOpenFiles.setState({ tabs: load() });
}

/** The open tabs inside a deleted file or folder. */
export function tabsUnder(root: string): string[] {
  return useOpenFiles
    .getState()
    .tabs.filter((tab) => under(tab.path, root))
    .map((tab) => tab.path);
}
