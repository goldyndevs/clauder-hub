import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "./api";
import { GLOBAL_ID, setCurrentProject } from "./project";
import { switchProjectStores } from "./projectStores";
import type { Health, Interaction, Session } from "./types";

/**
 * Where switching to a project lands: a live session waiting on you, else a
 * live one running, else the latest done one, else the latest session (hub
 * tasks aside), which opening resumes; the project's overview only when it has none.
 */
function landingSession(sessions: Session[]): Session | null {
  const latest = (list: Session[]) => [...list].sort((a, b) => (b.lastAt ?? b.startedAt ?? "").localeCompare(a.lastAt ?? a.startedAt ?? ""))[0] ?? null;
  return (
    latest(sessions.filter((session) => session.live && session.status === "waiting")) ??
    latest(sessions.filter((session) => session.live && session.status === "running")) ??
    latest(sessions.filter((session) => session.status === "done")) ??
    latest(sessions.filter((session) => !session.purpose))
  );
}

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
  /** The project being switched to while the shown one stays on screen; null when none. */
  switching: string | null;
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
  /** Shows a session of any project, switching to it first when it is another. */
  openSessionIn: (projectId: string, sessionId: string) => void;
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

/** What switching to a project reads, read again after this long. */
const PREFETCH_FRESH = 10_000;
const prefetched = new Map<string, { at: number; read: Promise<[Health, Session[], Interaction[]]> }>();

/** A project's health, sessions and open interactions; a recent prefetch is used once when taking it. */
function readProject(projectId: string, take = false): Promise<[Health, Session[], Interaction[]]> {
  const hit = prefetched.get(projectId);
  if (hit && Date.now() - hit.at < PREFETCH_FRESH) {
    if (take) prefetched.delete(projectId);
    return hit.read;
  }
  const read = <T,>(path: string) =>
    fetch(`/api/p/${encodeURIComponent(projectId)}${path}`).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
      return payload as T;
    });
  return Promise.all([read<Health>("/health"), read<Session[]>("/sessions"), read<Interaction[]>("/interactions?status=open")]);
}

/** Pointing at another project reads it ahead, so the switch that may follow is instant. */
export function prefetchProject(projectId: string): void {
  if (projectId === useStore.getState().projectId) return;
  const hit = prefetched.get(projectId);
  if (hit && Date.now() - hit.at < PREFETCH_FRESH) return;
  const read = readProject(projectId);
  // A failed read is not kept: the switch reads again and says what went wrong.
  read.catch(() => prefetched.delete(projectId));
  prefetched.set(projectId, { at: Date.now(), read });
}

export const useStore = create<State>((set, get) => {
  /**
   * Switches what the page shows to another project (or home): its state is
   * dropped and read again, and the per-project stores (open tabs, unsaved
   * edits) swap to that project's. The page remounts on the new project.
   */
  /** The project the page is on its way to, while the one shown stays usable; null when none. */
  let wanted: string | null = null;

  /**
   * From one project to another: the one shown stays on screen and usable
   * while the next is read, then the page swaps to it in one go. A thin bar
   * says it is on its way. Going somewhere in the shown project meanwhile
   * drops the switch.
   */
  const switchTo = async (projectId: string, next: { view: View; windowed: boolean }) => {
    wanted = projectId;
    set({ switching: projectId });
    try {
      const [health, sessions, open] = await readProject(projectId, true);
      if (wanted !== projectId) return;
      wanted = null;
      setCurrentProject(projectId);
      switchProjectStores(projectId);
      set({ projectId, health, sessions, open, transcriptTicks: {}, view: next.view, windowed: next.windowed, switching: null });
      if (projectId !== GLOBAL_ID) void api.openedProject(projectId).catch(() => undefined);
    } catch (cause) {
      if (wanted !== projectId) return;
      wanted = null;
      set({ switching: null });
      // Only the hub saying it has no such project sends the page home; anything else is shown and the page stays.
      if (/no such project/i.test((cause as Error).message)) {
        get().notify(`The hub has no project '${projectId}'. Open its folder again from here.`, "error");
        get().openProject(GLOBAL_ID);
        return;
      }
      get().notify(`Could not open the project: ${(cause as Error).message}`, "error");
      // The route goes back to what is still shown.
      history.replaceState(null, "", hashOf(get().projectId, get().view, get().windowed));
    }
  };

  const enter = async (projectId: string | null) => {
    wanted = null;
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
    switching: null,
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
        // Another project with one already shown: it stays until the next is read.
        if (changed && next.projectId && get().health) return void switchTo(next.projectId, next);
        // Somewhere in the shown project: a switch on its way is dropped.
        wanted = null;
        set({ view: next.view, windowed: next.windowed, switching: null });
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
      const show = (view: View) => {
        const hash = hashOf(id, view, false);
        // The same hash fires no hashchange (a project opened again right after a failed open).
        if (window.location.hash === hash && id && id !== get().projectId) void (get().health ? switchTo(id, { view, windowed: false }) : enter(id));
        window.location.hash = hash.slice(1);
      };
      if (!id || id === GLOBAL_ID || id === get().projectId) return show({ kind: "page", page: "overview" });
      void api.sessionsIn(id).then(
        (sessions) => {
          const target = landingSession(sessions);
          if (!target) return show({ kind: "page", page: "overview" });
          show({ kind: "session", id: target.id });
        },
        // An unreadable project still opens; its overview says what is wrong.
        () => show({ kind: "page", page: "overview" }),
      );
    },

    openSessionIn: (projectId, sessionId) => {
      if (projectId === get().projectId) return get().go({ kind: "session", id: sessionId });
      window.location.hash = hashOf(projectId, { kind: "session", id: sessionId }, false).slice(1);
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
