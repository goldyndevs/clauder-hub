import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AutomationPage } from "./components/AutomationPage";
import { CategoriesPage } from "./components/CategoriesPage";
import { ChannelsPage } from "./components/ChannelsPage";
import { ClaudeSettingsPage } from "./components/ClaudeSettingsPage";
import { ConfirmProvider } from "./components/Confirm";
import { FileView } from "./components/FileView";
import { HubPromptsPage } from "./components/HubPromptsPage";
import { GlobalShell } from "./components/GlobalPage";
import { GLOBAL_ID } from "./lib/project";
import { InboxPage } from "./components/InboxPage";
import { McpSuggestionsPage } from "./components/McpPage";
import { OverviewPage } from "./components/OverviewPage";
import { PresetsPage } from "./components/PresetsPage";
import { DefinitionsPage, HooksPage, InstructionsPage, McpServersPage, PluginsPage } from "./components/ProjectPages";
import { ResizeHandle } from "./components/ResizeHandle";
import { SessionView } from "./components/SessionView";
import { FileTabs } from "./components/FileTabs";
// import { RunningDock } from "./components/RunningDock";
import { TerminalTabs } from "./components/TerminalTabs";
import { FOCUS_SESSIONS_EVENT, MobileBar, Sidebar } from "./components/Sidebar";
import { cn } from "./lib/cn";
import { useStore, type Page } from "./lib/store";
import { useMediaQuery } from "./lib/useMediaQuery";
import { usePersistentWidth } from "./lib/usePersistentWidth";

const COLLAPSED_KEY = "clauder-hub:sidebar-collapsed";

/**
 * The one toast: the primary orange, rounded and soft, an icon saying how it
 * went, a little see-through until the pointer is on it.
 */
function Toast({ text, failed }: { text: string; failed: boolean }) {
  const Icon = failed ? AlertTriangle : CheckCircle2;
  return (
    <div
      role={failed ? "alert" : "status"}
      className={cn(
        "fixed bottom-4 left-1/2 z-[60] flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs opacity-85 shadow-lg shadow-black/25 transition-opacity animate-in fade-in-0 slide-in-from-bottom-2 hover:opacity-100 sm:max-w-lg",
        failed ? "bg-primary text-primary-foreground" : "bg-success text-success-foreground",
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

const PAGE_VIEW: Record<Page, () => ReactNode> = {
  overview: () => <OverviewPage />,
  inbox: () => <InboxPage />,
  automation: () => <AutomationPage />,
  instructions: () => <InstructionsPage />,
  agents: () => <DefinitionsPage key="agents" kind="agents" />,
  skills: () => <DefinitionsPage key="skills" kind="skills" />,
  commands: () => <DefinitionsPage key="commands" kind="commands" />,
  "mcp-servers": () => <McpServersPage />,
  hooks: () => <HooksPage />,
  plugins: () => <PluginsPage />,
  channels: () => <ChannelsPage />,
  "hub-prompts": () => <HubPromptsPage />,
  "claude-settings": () => <ClaudeSettingsPage />,
  "mcp-suggestions": () => <McpSuggestionsPage />,
  presets: () => <PresetsPage />,
  categories: () => <CategoriesPage />,
};

export default function App() {
  const { boot, view, toast, health, windowed, projectId } = useStore();
  const [error, setError] = useState<string | null>(null);
  const left = usePersistentWidth("clauder-hub:sidebar-width", 280, { min: 220, max: 480 });
  // Below md the sidebar is a drawer over the page, opened from the top bar.
  const wide = useMediaQuery("(min-width: 768px)");
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Private windows and blocked site data: the preference just does not persist.
    }
  }, [collapsed]);

  // Going anywhere closes the drawer, and so does growing past md.
  useEffect(() => setDrawer(false), [view, wide]);

  // Ctrl+` from anywhere, the terminal and the editor included (caught before they see it):
  // the sidebar comes out on its Sessions tab and the live sessions light up.
  useEffect(() => {
    if (windowed) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.code !== "Backquote") return;
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(false);
      if (!wide) setDrawer(true);
      // After the sidebar has had a frame to mount, if it was folded away.
      window.setTimeout(() => window.dispatchEvent(new Event(FOCUS_SESSIONS_EVENT)), 30);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [windowed, wide]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  useEffect(() => {
    boot().catch((cause: Error) => setError(cause.message));
  }, [boot]);

  // The browser tab is named after the project, in every view and window, so several hubs tell apart.
  useEffect(() => {
    if (health) document.title = health.project;
  }, [health]);

  // Until the project has answered, nothing below may ask it anything.
  if (!health) return <div className="grid h-screen place-items-center text-xs text-muted-foreground">Opening the project...</div>;
  // #/global is the hub's own context: every project at once, not one project's sidebar.
  if (projectId === GLOBAL_ID) {
    return (
      <ConfirmProvider>
        <GlobalShell />
        {(error || toast) && <Toast text={(error ?? toast?.text)!} failed={Boolean(error) || toast?.tone === "error"} />}
      </ConfirmProvider>
    );
  }

  const content =
    view.kind === "session" ? <SessionView key={view.id} id={view.id} /> : view.kind === "file" ? <FileView key={view.path} path={view.path} /> : PAGE_VIEW[view.page]();

  return (
    <ConfirmProvider>
      {/* Keyed by project: switching remounts everything, so nothing of the last one lingers. */}
      <div key={projectId} className="flex h-screen overflow-hidden">
        {/* A window of its own holds one session, nothing else. */}
        {!windowed && wide && <Sidebar width={left.width} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />}
        {!windowed && wide && !collapsed && <ResizeHandle onDrag={left.resizeBy} onReset={left.reset} />}
        {!windowed && !wide && (
          <>
            {drawer && <div className="fixed inset-0 z-40 bg-foreground/40 animate-in fade-in-0" onClick={() => setDrawer(false)} />}
            {/* Kept mounted so it can slide; inert while closed, so its controls are out of the tab order. */}
            <div
              inert={!drawer}
              className={cn("fixed inset-y-0 left-0 z-40 flex border-r bg-background transition-transform duration-200", drawer ? "translate-x-0 shadow-xl" : "-translate-x-full")}
            >
              <Sidebar width="min(280px, 85vw)" collapsed={false} onToggle={() => setDrawer(false)} drawer />
            </div>
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {!windowed && !wide && <MobileBar onMenu={() => setDrawer(true)} />}
          {health && !health.claude && (
            <div className="border-b bg-destructive/15 px-5 py-2 text-xs">Claude Code was not found on this machine. Install it with 'npm i -g @anthropic-ai/claude-code' and restart the hub.</div>
          )}
          {!windowed && <TerminalTabs />}
          {!windowed && <FileTabs active={view.kind === "file" ? view.path : null} />}
          {/* Replaced by the terminal tabs above for now; kept to bring back. */}
          {/* {!windowed && <RunningDock />} */}
          <div className="min-h-0 flex-1">{content}</div>
        </main>

        {(error || toast) && <Toast text={(error ?? toast?.text)!} failed={Boolean(error) || toast?.tone === "error"} />}
      </div>
    </ConfirmProvider>
  );
}
