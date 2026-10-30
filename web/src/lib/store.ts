import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "./api";
import { GLOBAL_ID, setCurrentProject } from "./project";
import { switchProjectStores } from "./projectStores";
import type { Health, Interaction, Session } from "./types";

export type Topic = "sessions" | "transcript" | "interactions" | "runs" | "jobs" | "mcp" | "channels" | "files" | "projects";

export const PAGES = [
  "overview",
  "inbox",
  "automation",
  "instructions",
  "agents",
  "skills",
  "commands",
  "mcp-servers",
  "hooks",
  "plugins",
  "channels",
  "hub-prompts",
  "claude-settings",
  "mcp-suggestions",
  "presets",
  "categories",
] as const;
export type Page = (typeof PAGES)[number];
export type View = { kind: "page"; page: Page } | { kind: "session"; id: string } | { kind: "file"; path: string };

interface State {
  /** The project shown, from the route; null on the home page. */
  projectId: string | null;
  health: Health | null;
  sessions: Session[];
  open: Interaction[];
  view: View;
  /** A window of its own (#/w/...): one session or the new-session form, no sidebar. */
  windowed: boolean;
  /** Bumped per topic by the live feed; a page refetches what it shows when its topics move. */
  ticks: Record<Topic, number>;
  /** The session ids whose transcripts moved, with the tick they moved at. */
  transcriptTicks: Record<string, number>;
  toast: { text: string; tone: "error" | "info" } | null;

  boot: () => Promise<void>;
  go: (view: View) => void;
  /** Shows a project, or the home page with null. */
  openProject: (id: string | null) => void;
  refreshSessions: () => Promise<void>;
  refreshOpen: () => Promise<void>;
  notify: (text: string, tone?: "error" | "info") => void;
}

let source: EventSource | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** A hand-typed hash can hold a stray "%"; it is then taken as written. */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** #/ is home; #/<project>/<page>, #/<project>/session/<id> and #/<project>/file/<path> are inside a project; #/w/... is the same in a window of its own. */
function readHash(): { projectId: string | null; view: View; windowed: boolean } {
  let hash = window.location.hash.replace(/^#\/?/, "");
  const windowed = hash.startsWith("w/");
  if (windowed) hash = hash.slice(2);
  const slash = hash.indexOf("/");
  // #/ is the global page: every project at once, where a project is opened or added.
  const projectId = decodePart(slash === -1 ? hash : hash.slice(0, slash)) || GLOBAL_ID;
  hash = slash === -1 ? "" : hash.slice(slash + 1);
  if (hash.startsWith("session/")) return { projectId, view: { kind: "session", id: hash.slice("session/".length) }, windowed };
  if (hash.startsWith("file/")) return { projectId, view: { kind: "file", path: hash.slice("file/".length).split("/").map(decodePart).join("/") }, windowed };
  return { projectId, view: { kind: "page", page: PAGES.find((page) => page === hash) ?? "overview" }, windowed };
}

function hashOf(projectId: string | null, view: View, windowed: boolean): string {
  if (!projectId) return hashOf(GLOBAL_ID, view, windowed);
  const path =
    view.kind === "session" ? `session/${view.id}` : view.kind === "file" ? `file/${view.path.split("/").map(encodeURIComponent).join("/")}` : view.page;
  return `#/${windowed ? "w/" : ""}${encodeURIComponent(projectId)}/${path}`;
}

/** Opens a view of the current project in a browser window of its own, so several terminals can sit side by side. */
export function openWindow(view: View): void {
  const projectId = useStore.getState().projectId;
  const name = view.kind === "session" ? `clauder-${projectId}-${view.id}` : view.kind === "file" ? `clauder-file-${projectId}-${view.path}` : `clauder-${projectId}-${view.page}`;
  window.open(`${location.origin}${location.pathname}${hashOf(projectId, view, true)}`, name, "popup,width=1280,height=820");
}

const NO_TICKS: Record<Topic, number> = { sessions: 0, transcript: 0, interactions: 0, runs: 0, jobs: 0, mcp: 0, channels: 0, files: 0, projects: 0 };

export const useStore = create<State>((set, get) => {
  /**
   * Switches what the page shows to another project (or home): its state is
   * dropped and read again, and the per-project stores (open tabs, unsaved
   * edits) swap to that project's. The page remounts on the new project.
   */
  const enter = async (projectId: string | null) => {
    setCurrentProject(projectId);
    switchProjectStores(projectId);
    set({ projectId, health: null, sessions: [], open: [], transcriptTicks: {} });
    if (!projectId) return;
    try {
      const [health] = await Promise.all([api.health(), get().refreshSessions(), get().refreshOpen()]);
      if (get().projectId === projectId) set({ health });
      // The global context is not a project, so it has no place in the recent list.
      if (projectId !== GLOBAL_ID) void api.openedProject(projectId).catch(() => undefined);
    } catch (cause) {
      if (get().projectId !== projectId) return;
      // Only the hub saying it has no such project sends the page home; anything else is shown and can be retried.
      if (/no such project/i.test((cause as Error).message)) {
        // A route to a project the hub does not have (removed, or a stale link) lands on the global page.
        get().notify(`The hub has no project '${projectId}'. Open its folder again from here.`, "error");
        get().openProject(GLOBAL_ID);
      }
      else get().notify(`Could not open the project: ${(cause as Error).message}`, "error");
    }
  };

  return {
    health: null,
    sessions: [],
    open: [],
    ...readHash(),
    ticks: { ...NO_TICKS },
    transcriptTicks: {},
    toast: null,

    boot: async () => {
      window.addEventListener("hashchange", () => {
        const next = readHash();
        const changed = next.projectId !== get().projectId;
        set({ view: next.view, windowed: next.windowed });
        if (changed) void enter(next.projectId);
      });

      source?.close();
      source = new EventSource("/api/stream");
      // Coalesced: a busy session moves its transcript several times a second.
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const ticks = { ...get().ticks };
        const transcriptTicks = { ...get().transcriptTicks };
        for (const key of pending) {
          if (key.startsWith("transcript:")) transcriptTicks[key.slice("transcript:".length)] = Date.now();
          else ticks[key as Topic] += 1;
        }
        const touched = new Set(pending);
        pending.clear();
        set({ ticks, transcriptTicks });
        if (!get().projectId) return;
        // The sidebar shows titles, token counts and waiting badges, so all three move it.
        if (touched.has("sessions") || touched.has("transcript") || touched.has("interactions")) void get().refreshSessions();
        if (touched.has("interactions")) void get().refreshOpen();
      };
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as { topic: Topic; project?: string; payload: { sessionId?: string } };
        // Every project's events come down one feed; another project's only move the project list.
        if (event.project && event.project !== get().projectId) {
          pending.add("projects");
        } else {
          pending.add(event.topic === "transcript" ? `transcript:${event.payload.sessionId}` : event.topic);
          if (event.topic === "transcript") pending.add("transcript");
        }
        timer ??= setTimeout(flush, 400);
      };
      // A dropped stream reconnects by itself; whatever moved meanwhile is fetched again.
      source.onopen = () => {
        if (!get().projectId) return;
        void get().refreshSessions();
        void get().refreshOpen();
      };

      await enter(get().projectId);
    },

    go: (view) => {
      window.location.hash = hashOf(get().projectId, view, get().windowed).slice(1);
      set({ view });
    },

    openProject: (id) => {
      const hash = hashOf(id, { kind: "page", page: "overview" }, false);
      // The same hash fires no hashchange (a project opened again right after a failed open).
      if (window.location.hash === hash && id !== get().projectId) void enter(id);
      window.location.hash = hash.slice(1);
    },

    refreshSessions: async () => {
      const projectId = get().projectId;
      if (!projectId) return;
      const sessions = await api.sessions();
      if (get().projectId === projectId) set({ sessions });
    },

    refreshOpen: async () => {
      const projectId = get().projectId;
      if (!projectId) return;
      const open = await api.interactions("open");
      if (get().projectId === projectId) set({ open });
    },

    notify: (text, tone = "info") => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: { text, tone } });
      toastTimer = setTimeout(() => set({ toast: null }), tone === "error" ? 6000 : 3000);
    },
  };
});

/**
 * Loads something and loads it again whenever one of its topics moves. The
 * server never pushes state, only "this changed", so every view reads through
 * the same API it would read on first load.
 */
export function useLive<T>(load: () => Promise<T>, topics: Topic[], extraKey: unknown = null): { data: T | null; error: string | null; reload: () => void } {
  const ticks = useStore((state) => topics.map((topic) => state.ticks[topic]).join(","));
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      },
      (cause: Error) => !cancelled && setError(cause.message),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks, nonce, JSON.stringify(extraKey)]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, reload };
}

/** Runs an action, toasting its error instead of throwing it into the void. */
export async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action();
    if (success) useStore.getState().notify(success);
    return result;
  } catch (error) {
    useStore.getState().notify((error as Error).message, "error");
    return undefined;
  }
}
