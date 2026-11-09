import { ArrowRight, Bell, BellOff, CalendarClock, Check, Settings, LogIn, Pencil, RefreshCw, ChevronsLeft, ChevronsRight, FolderGit2, FolderOpen, Inbox, LayoutGrid, Link, ListOrdered, Menu, Plus, Radio, Trash2, VolumeX, Wrench, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { compact, when } from "../lib/format";
import { attempt, useLive, useStore, type Page } from "../lib/store";
import type { AuthInfo, GlobalProject, Profile } from "../lib/types";
import { useProfileList, useProfiles } from "../lib/profiles";
import { shortLabel, useUsage, type UsageReading } from "../lib/usage";
import { useHubSettings, useHubSettingsData, type HubSettings } from "../lib/hubSettings";
import { useMediaQuery } from "../lib/useMediaQuery";
import { usePersistentWidth } from "../lib/usePersistentWidth";
import { ChannelsPage } from "./ChannelsPage";
import { InteractionCard } from "./InteractionCard";
import { PageHeader } from "./Page";
import { useConfirm } from "./Confirm";
import { LogoLink, OpenFolderDialog, TitleLink } from "./Projects";
import { ResizeHandle } from "./ResizeHandle";
import { SessionView } from "./SessionView";
import { StatusDot } from "./Sidebar";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Input } from "./ui/Input";
import { Empty } from "./ui/Empty";
import { ClaudeBanner } from "./ClaudeBanner";
import { Tooltip } from "./ui/Tooltip";
import { LivePanel, useLivePanel } from "./LivePanel";

/** #/global's pages: they reuse the project page names, so the route reads #/global/inbox. */
const GLOBAL_NAV: Array<{ page: Page; label: string; icon: typeof Inbox }> = [
  { page: "overview", label: "Projects", icon: LayoutGrid },
  { page: "inbox", label: "Inbox", icon: Inbox },
  { page: "channels", label: "Channels", icon: Radio },
  { page: "hub-settings", label: "Settings", icon: Settings },
];

let homeFolder: Promise<string | null> | null = null;
/** The hub machine's home folder, asked once: a project's relative path starts from it. */
function home(): Promise<string | null> {
  homeFolder ??= api.folders().then(
    (folders) => folders.home,
    () => null,
  );
  return homeFolder;
}

function copyText(text: string, what: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => useStore.getState().notify(`Copied the ${what}.`),
    () => useStore.getState().notify("The browser did not allow copying.", "error"),
  );
}

/** What the project menu needs to know of a project; muted and paused are unknown until the overview has loaded. */
type MenuProject = Pick<GlobalProject, "id" | "name" | "root"> & Partial<Pick<GlobalProject, "muted" | "paused">>;

/** A project's right-click menu, on its card, in the sidebar and in the live panel: open it, quiet it, copy where it is, show it, take it off the hub. */
export function ProjectMenu({ project, x, y, onClose }: { project: MenuProject; x: number; y: number; onClose: () => void }) {
  const openProject = useStore((state) => state.openProject);
  const confirm = useConfirm();
  const toggleMute = () =>
    attempt(() => api.setMuted(project.id, !project.muted), project.muted ? `${project.name} is heard on the global channels again.` : `The global channels no longer hear from ${project.name}.`);
  const remove = () =>
    confirm({
      title: `Remove ${project.name} from the hub?`,
      description: "Its running sessions stop and its jobs no longer run. The folder and its saved settings stay.",
      confirmLabel: "Remove",
      tone: "destructive",
      run: async () => {
        await api.removeProject(project.id);
        useStore.getState().notify(`Removed ${project.name}. Opening its folder again brings it back as it was.`);
      },
    });
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const relative = async () => {
    const base = await home();
    const root = project.root;
    const sep = root.includes("\\") ? "\\" : "/";
    const inside = base && root.toLowerCase().startsWith(`${base.replace(/[\\/]$/, "").toLowerCase()}${sep}`);
    copyText(inside ? `~${sep}${root.slice(base!.replace(/[\\/]$/, "").length + 1)}` : root, "relative path");
  };

  const item = (label: string, icon: typeof Bell, run: () => void, options: { danger?: boolean; hint?: string } = {}) => {
    const Icon = icon;
    return (
      <button
        title={options.hint}
        // Pointer-down closes the menu, so the action runs on that, before the window listener.
        onPointerDown={(event) => {
          event.stopPropagation();
          onClose();
          run();
        }}
        className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs", options.danger ? "text-severity-critical hover:bg-destructive/15" : "hover:bg-muted")}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  return (
    <div
      role="menu"
      className="fixed z-50 w-56 rounded-lg border bg-card p-1 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 232), top: Math.min(y, window.innerHeight - 290) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {item("Open", ArrowRight, () => openProject(project.id))}
      <div className="my-1 border-t" />
      {project.paused
        ? item("Allow notifications", Bell, () => void attempt(() => api.pauseNotificationsIn(project.id, false), `Notifications from ${project.name} are back on.`))
        : item("Do not disturb", BellOff, () => void attempt(() => api.pauseNotificationsIn(project.id, true), `No channel hears from ${project.name} now.`), {
            hint: "Pauses every channel of this project, and the global ones for it; questions still wait in the inbox",
          })}
      {item(project.muted ? "Hear on global channels" : "Mute on global channels", project.muted ? Radio : VolumeX, () => void toggleMute(), {
        hint: "Only the global channels; the project's own channels are not changed",
      })}
      <div className="my-1 border-t" />
      {item("Copy Path", Link, () => copyText(project.root, "path"))}
      {item("Copy Relative Path", Link, () => void relative(), { hint: "From your home folder, as ~/..." })}
      {item("Reveal in File Explorer", FolderOpen, () => void attempt(() => api.revealIn(project.id)))}
      <div className="my-1 border-t" />
      {item("Remove from the hub", Trash2, () => void remove(), { danger: true, hint: "The folder and its saved settings stay" })}
    </div>
  );
}

/** One project at a glance: what runs, what waits, what comes next. A click opens it. */
function ProjectCard({ project }: { project: GlobalProject }) {
  const openProject = useStore((state) => state.openProject);
  const confirm = useConfirm();
  const toggleMute = () =>
    attempt(() => api.setMuted(project.id, !project.muted), project.muted ? `${project.name} is heard on the global channels again.` : `The global channels no longer hear from ${project.name}.`);
  const remove = () =>
    confirm({
      title: `Remove ${project.name} from the hub?`,
      description: "Its running sessions stop and its jobs no longer run. The folder and its saved settings stay.",
      confirmLabel: "Remove",
      tone: "destructive",
      run: async () => {
        await api.removeProject(project.id);
        useStore.getState().notify(`Removed ${project.name}. Opening its folder again brings it back as it was.`);
      },
    });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className="card flex min-w-0 flex-col gap-2 p-3"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu && <ProjectMenu project={project} {...menu} onClose={() => setMenu(null)} />}
      <div className="flex items-start gap-2">
        <button onClick={() => openProject(project.id)} className="min-w-0 flex-1 text-left" title={project.root}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold hover:underline">{project.name}</span>
            {project.paused && (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-severity-warning/15 px-1 text-[9px] font-medium text-severity-warning" title="Do not disturb: no channel hears from it">
                <BellOff size={9} /> DND
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{project.root}</div>
        </button>
        <button
          onClick={() => void toggleMute()}
          title={project.muted ? "Muted on the global channels: click to hear from it again" : "Heard on the global channels: click to mute"}
          aria-label={project.muted ? `Unmute ${project.name}` : `Mute ${project.name}`}
          className={cn("shrink-0 rounded p-1 hover:bg-muted", project.muted ? "text-muted-foreground" : "text-foreground")}
        >
          {project.muted ? <BellOff size={13} /> : <Bell size={13} />}
        </button>
        <button onClick={() => void remove()} title="Remove from the hub" aria-label={`Remove ${project.name}`} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X size={13} />
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span className={cn(project.waiting ? "font-semibold text-severity-warning" : "text-muted-foreground")}>⏳ {project.waiting} waiting</span>
        <span className="text-muted-foreground">▶️ {project.running} running</span>
        <span className="flex items-center gap-1 text-muted-foreground" title={project.runningRun ? `Running: ${project.runningRun}` : undefined}>
          <ListOrdered size={11} /> {project.runningRun ? "1 running, " : ""}
          {project.queued} queued
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 max-w-full items-center gap-1 truncate" title={project.nextCron ? `${project.nextCron.name}: ${when(project.nextCron.at)}` : undefined}>
          <CalendarClock size={11} className="shrink-0" /> <span className="truncate">{project.nextCron ? `${project.nextCron.name} · ${when(project.nextCron.at)}` : "no cron job"}</span>
        </span>
        <span title="Sent and written in the sessions active today, cache reads left out">
          {project.activeToday} active today · {compact(project.tokensToday)} tokens
        </span>
      </div>
    </div>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5">{children}</div>
    </div>
  );
}

/** One setting: a switch, its name and what it does. */
function SettingRow({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 px-4 py-3", disabled && "cursor-default opacity-60")}>
      <Checkbox checked={checked} onCheckedChange={onChange} disabled={disabled} ariaLabel={label} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/**
 * #/global/hub-settings: how the hub behaves, for every project. The live
 * panel is this browser's own; the rest is the hub's, for every browser.
 */
export function HubSettingsPage() {
  const settings = useHubSettingsData();
  const save = useHubSettings((state) => state.save);
  const panel = useLivePanel();
  const change = async (patch: Partial<HubSettings>, message: string) => {
    if (await save(patch)) useStore.getState().notify(message);
  };
  return (
    <Scroll>
      <PageHeader group="Global" title="Settings" description="How the hub behaves, in every project." />
      <section className="divide-y rounded-md border">
        <div className="bg-muted/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Layout (this browser)</div>
        <SettingRow
          label="Show the live sessions panel"
          hint="The right sidebar with every project's open sessions. Also the toggle beside the hub's name."
          checked={panel.open}
          onChange={(on) => on !== panel.open && panel.toggle()}
        />
      </section>
      <section className="divide-y rounded-md border">
        <div className="bg-muted/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sessions (the whole hub)</div>
        <SettingRow
          label="Confirm before stopping a session"
          hint="Stop in a session, its menu, a terminal tab's close and Stop all ask first. Off: they stop at once; the conversation is kept for a resume either way."
          checked={settings?.confirmStop ?? true}
          disabled={!settings}
          onChange={(on) => void change({ confirmStop: on }, on ? "Stopping a session asks first." : "Sessions stop without asking.")}
        />
        <SettingRow
          label="Fullscreen terminal"
          hint="Sessions run Claude Code's fullscreen renderer: a click moves the cursor in the prompt and the wheel scrolls inside Claude. Claude Code can turn its own fullscreen setting off after a glitch; this keeps it on. Applies to sessions started or resumed from now on."
          checked={settings?.fullscreen ?? false}
          disabled={!settings}
          onChange={(on) => void change({ fullscreen: on }, on ? "New and resumed sessions run fullscreen." : "Sessions follow Claude Code's own setting again.")}
        />
        <SettingRow
          label="Resume running sessions after a restart"
          hint="Sessions still running when the hub stops (Ctrl+C, a closed window, a crash) are resumed when it starts again; queued runs go back on the queue."
          checked={settings?.resumeOnStart ?? true}
          disabled={!settings}
          onChange={(on) => void change({ resumeOnStart: on }, on ? "Sessions will be resumed after a restart." : "Sessions stay stopped after a restart.")}
        />
      </section>
    </Scroll>
  );
}

/** #/global/overview: every project's card. */
function GlobalProjects() {
  const [picking, setPicking] = useState(false);
  const overview = useLive(() => api.globalOverview(), ["projects", "sessions", "interactions", "runs", "jobs", "channels"]);
  return (
    <Scroll>
      <PageHeader
        group="Global"
        title="Projects"
        description="Every project in the hub, most recently opened first. The bell says whether the global channels hear from it."
        action={
          <Button variant="primary" onClick={() => setPicking(true)}>
            <Plus size={12} /> Open folder...
          </Button>
        }
      />
      <OpenFolderDialog open={picking} onOpenChange={setPicking} />
      {overview.data?.length ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {overview.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <Empty variant="inline" title={overview.data ? "No projects yet." : "Loading..."} />
      )}
    </Scroll>
  );
}

/** #/global/inbox: everything waiting on a person, in every project, answered here. */
function GlobalInbox() {
  const inbox = useLive(() => api.globalInbox(), ["projects", "interactions"]);
  return (
    <Scroll>
      <PageHeader group="Global" title="Inbox" description="Everything waiting on you, in every project." />
      {inbox.data?.length ? (
        <div className="space-y-2">
          {inbox.data.map((item) => (
            <InteractionCard key={`${item.project.id}:${item.id}`} interaction={item} project={item.project} showSession />
          ))}
        </div>
      ) : (
        // The same empty state as a project's inbox.
        <Empty icon={Bell} title={inbox.data ? "Nothing is waiting on you." : "Loading..."} />
      )}
    </Scroll>
  );
}

const PLAN_LABEL: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

/** The organisation and plan an account belongs to, for beside its email. */
function aboutOf(auth: AuthInfo | null): string {
  const plan = auth?.plan ? (PLAN_LABEL[auth.plan] ?? auth.plan) : null;
  return [auth?.org, plan && `${plan} plan`].filter(Boolean).join(" · ");
}

/** An account's plan usage as /usage shows it: a thin bar per limit, amber from 80%, red from 95%. */
function UsageBars({ reading, loading }: { reading: UsageReading | undefined; loading: boolean }) {
  if (!reading) return loading ? <div className="pl-0.5 text-[10px] text-muted-foreground/70">Reading usage...</div> : null;
  if (reading.error) return <div className="truncate pl-0.5 text-[10px] text-muted-foreground/70" title={reading.error}>Usage: {reading.error}</div>;
  return (
    <div className="space-y-0.5 py-0.5" title={`Read from /usage ${new Date(reading.at).toLocaleTimeString()}`}>
      {reading.items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5 text-[10px]" title={`${item.label}: ${item.percent}% used${item.detail ? `, ${item.detail}` : ""}`}>
          <span className="w-16 shrink-0 truncate">{shortLabel(item.label)}</span>
          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full", item.percent >= 95 ? "bg-severity-critical" : item.percent >= 80 ? "bg-severity-warning" : "bg-primary")}
              style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }}
            />
          </span>
          <span className={cn("w-8 shrink-0 text-right tabular-nums", item.percent >= 95 ? "text-severity-critical" : item.percent >= 80 ? "text-severity-warning" : "")}>{item.percent}%</span>
        </div>
      ))}
    </div>
  );
}

/** A name typed into a confirm dialog, read when it is confirmed. */
function NameField({ holder, placeholder }: { holder: { value: string }; placeholder: string }) {
  const [value, setValue] = useState(holder.value);
  return (
    <Input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(event) => {
        setValue(event.target.value);
        holder.value = event.target.value;
      }}
    />
  );
}

/**
 * The Claude accounts sessions run under. With one, just who it is; with more,
 * each one, the hub's default checked (a click on another makes it the
 * default), and per account: sign in, rename, remove. Adding one creates its
 * folder and opens a session in it to sign in.
 */
function Accounts() {
  const info = useProfileList();
  const load = useProfiles((state) => state.load);
  const usage = useUsage((state) => state.data);
  const usageLoading = useUsage((state) => state.loading);
  const readingOf = (id: string) => usage?.find((item) => item.profileId === id);
  const go = useStore((state) => state.go);
  const confirm = useConfirm();
  if (!info) return <div>Checking...</div>;
  const several = info.profiles.length > 1;

  const signIn = async (profile: Profile) => {
    const started = await attempt(() => api.startSession({ profile: profile.id, name: `Sign in: ${profile.name}` }));
    if (!started) return;
    await useStore.getState().refreshSessions();
    go({ kind: "session", id: started.sessionId });
    useStore.getState().notify("Sign in there with /login, then press the refresh icon.");
  };
  const add = () => {
    const holder = { value: "" };
    void confirm({
      title: "Add a Claude account",
      description: "It gets a Claude folder of its own; skills, agents, plugins and settings are shared with the default one.",
      body: <NameField holder={holder} placeholder="Personal, Work, Client X..." />,
      confirmLabel: "Add and sign in",
      run: async () => {
        const profile = await api.createProfile(holder.value);
        await load(true);
        await signIn({ ...profile, auth: null });
      },
    });
  };
  const rename = (profile: Profile) => {
    const holder = { value: profile.name };
    void confirm({
      title: `Rename ${profile.name}`,
      body: <NameField holder={holder} placeholder="Name" />,
      confirmLabel: "Rename",
      run: async () => {
        await api.renameProfile(profile.id, holder.value);
        await load();
      },
    });
  };
  const remove = (profile: Profile) =>
    void confirm({
      title: `Remove the account ${profile.name}?`,
      description: "Its folder (sign-in and transcripts) stays on disk; sessions that ran under it can no longer be resumed from the hub.",
      body: <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[11px]">{profile.configDir}</code>,
      confirmLabel: "Remove",
      tone: "destructive",
      run: async () => {
        await api.removeProfile(profile.id);
        await load();
      },
    });
  const makeDefault = async (profile: Profile) => {
    if (profile.id === info.defaultId) return;
    if (await attempt(() => api.setDefaultProfile(profile.id), `New sessions use ${profile.name} unless a project picks another.`)) await load();
  };

  return (
    <div className="space-y-0.5">
      {info.profiles.map((profile) => {
        const about = aboutOf(profile.auth);
        const isDefault = profile.id === info.defaultId;
        const signedOut = profile.auth?.loggedIn === false;
        const line = (
          <span className="min-w-0 flex-1 truncate" title={[profile.auth?.account, about && `(${about})`].filter(Boolean).join(" ") || profile.configDir}>
            {several && <span className="font-medium text-foreground">{profile.name} </span>}
            {signedOut ? <span className="text-severity-warning">not signed in</span> : profile.auth?.account}
            {about && !signedOut && <span className="text-muted-foreground/70">{` (${about})`}</span>}
          </span>
        );
        if (!several)
          return (
            <div key={profile.id}>
              <div className="flex min-w-0 items-center">{line}</div>
              {!signedOut && <UsageBars reading={readingOf(profile.id)} loading={usageLoading} />}
            </div>
          );
        return (
          <div key={profile.id}>
          <div className={cn("group -mx-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5", isDefault ? "bg-muted/60" : "hover:bg-muted/40")}>
            <button
              onClick={() => void makeDefault(profile)}
              title={isDefault ? "The hub's default account" : `Make ${profile.name} the hub's default`}
              aria-label={isDefault ? "Default account" : `Make ${profile.name} the default`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <span className={cn("grid h-3 w-3 shrink-0 place-items-center rounded-full border", isDefault ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50")}>
                {isDefault && <Check size={8} strokeWidth={3} />}
              </span>
              {line}
            </button>
            <span className="hidden shrink-0 items-center group-hover:flex">
              <button onClick={() => void signIn(profile)} title="Open a session under it (sign in with /login)" aria-label={`Sign in to ${profile.name}`} className="rounded p-0.5 hover:bg-muted hover:text-foreground">
                <LogIn size={11} />
              </button>
              {!profile.builtIn && (
                <>
                  <button onClick={() => rename(profile)} title="Rename" aria-label={`Rename ${profile.name}`} className="rounded p-0.5 hover:bg-muted hover:text-foreground">
                    <Pencil size={11} />
                  </button>
                  <button onClick={() => remove(profile)} title="Remove from the hub" aria-label={`Remove ${profile.name}`} className="rounded p-0.5 hover:bg-muted hover:text-foreground">
                    <Trash2 size={11} />
                  </button>
                </>
              )}
            </span>
          </div>
          {!signedOut && (
            <div className="pl-[18px]">
              <UsageBars reading={readingOf(profile.id)} loading={usageLoading} />
            </div>
          )}
          </div>
        );
      })}
      <button onClick={add} className="flex items-center gap-1 rounded py-0.5 text-[11px] hover:text-foreground" title="Another Claude account, signed in separately">
        <Plus size={11} /> Add account
      </button>
    </div>
  );
}

/**
 * Claude Code as this machine runs it, at the foot of the global sidebar: who
 * is signed in and on what plan, until when, which version, and how much the
 * hub's sessions used today. Read from `claude auth status` and the transcripts.
 */
/** Whether this page load has asked Claude Code again yet; not again when the sidebar remounts. */
let checkedThisLoad = false;

function ClaudeInfo() {
  const hub = useLive(() => api.hub(), []);
  const overview = useLive(() => api.globalOverview(), ["sessions", "projects"]);
  const [checking, setChecking] = useState(false);
  const status = hub.data?.claudeStatus ?? null;
  const loadProfiles = useProfiles((state) => state.load);
  const loadUsage = useUsage((state) => state.load);
  const recheck = async () => {
    setChecking(true);
    // Usage takes a few seconds per account: it fills in after the rest.
    void loadUsage(true);
    await Promise.all([attempt(() => api.checkClaude()), loadProfiles(true)]);
    setChecking(false);
    hub.reload();
  };
  // The usage again every 15 minutes while the page is open; the hub keeps a reading 10.
  useEffect(() => {
    void loadUsage();
    const timer = window.setInterval(() => document.visibilityState === "visible" && void loadUsage(true), 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [loadUsage]);
  // Asked again once per page load, as if the refresh icon were pressed: a sign-in may have changed meanwhile.
  useEffect(() => {
    if (checkedThisLoad) return;
    checkedThisLoad = true;
    void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tokens = (overview.data ?? []).reduce((total, project) => total + project.tokensToday, 0);
  const active = (overview.data ?? []).reduce((total, project) => total + project.activeToday, 0);
  const signedIn = status?.loggedIn !== false && !status?.problem;

  return (
    <div className="space-y-1 border-t px-3 py-2.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", !status ? "bg-muted-foreground/40" : signedIn ? "bg-success" : "bg-severity-critical")} />
        <span className="font-medium text-foreground">Claude Code</span>
        {status?.version && <span className="font-mono">v{status.version}</span>}
        <button onClick={() => void recheck()} disabled={checking} title="Ask Claude Code again" aria-label="Check Claude Code again" className="ml-auto rounded p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50">
          <RefreshCw size={11} className={cn(checking && "animate-spin")} />
        </button>
      </div>
      {!status ? (
        <div>Checking...</div>
      ) : status.problem ? (
        <div className="text-severity-critical" title={status.fix ? `Fix: ${status.fix}` : undefined}>
          {status.message}
          {status.fix && <code className="mt-0.5 block font-mono text-foreground">{status.fix}</code>}
        </div>
      ) : (
        <Accounts />
      )}
      {overview.data && (
        <div title="Sent and written by the hub's sessions active today, cache reads left out">
          Today: {compact(tokens)} tokens · {active} session{active === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

/**
 * The global sidebar: the global pages, every project to jump into, and the
 * hub tasks that set up global channels. Folds to icons, and becomes a drawer
 * on a narrow window, like a project's.
 */
function GlobalSidebar({ width, collapsed, onToggle, drawer = false }: { width: number | string; collapsed: boolean; onToggle: () => void; drawer?: boolean }) {
  const view = useStore((state) => state.view);
  const go = useStore((state) => state.go);
  const openProject = useStore((state) => state.openProject);
  const sessions = useStore((state) => state.sessions);
  const projects = useLive(() => api.projects(), ["projects"]);
  // Muted and paused, for the projects' right-click menu.
  const overview = useLive(() => api.globalOverview(), ["projects", "channels"]);
  const [menu, setMenu] = useState<{ project: MenuProject; x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const inbox = useLive(() => api.globalInbox(), ["projects", "interactions"]);
  const waiting = inbox.data?.length ?? 0;
  const tasks = sessions.filter((session) => session.origin !== "external" || session.live).slice(0, 10);
  const isActive = (page: Page) => view.kind === "page" && (view.page === page || (page === "overview" && !GLOBAL_NAV.some((item) => item.page === view.page)));

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3">
        <LogoLink className="mb-2" />
        {GLOBAL_NAV.map((item) => (
          <Tooltip key={item.page} content={`Global · ${item.label}`} side="right" asChild>
            <Button variant="ghost" size="icon" className={cn(isActive(item.page) && "bg-muted text-foreground")} onClick={() => go({ kind: "page", page: item.page })}>
              <item.icon size={15} />
            </Button>
          </Tooltip>
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Expand sidebar">
          <ChevronsRight size={15} />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex shrink-0 flex-col" style={{ width }}>
      <div className="flex items-start gap-2 px-3 pb-2 pt-3">
        <LogoLink />
        <div className="min-w-0">
          <TitleLink />
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] text-muted-foreground">Global</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto self-center" onClick={onToggle} aria-label={drawer ? "Close menu" : "Collapse sidebar"}>
          {drawer ? <X size={15} /> : <ChevronsLeft size={15} />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav className="px-2">
          {GLOBAL_NAV.map((item) => (
            <button
              key={item.page}
              onClick={() => go({ kind: "page", page: item.page })}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                isActive(item.page) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <item.icon size={14} />
              {item.label}
              {item.page === "inbox" && waiting > 0 && <span className="ml-auto rounded-full bg-severity-warning px-1.5 text-[10px] font-semibold text-background">{waiting}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-2 px-2">
          <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Projects</div>
          <button
            onClick={() => setPicking(true)}
            title="Open a folder as a project"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <Plus size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Add project...</span>
          </button>
          {menu && <ProjectMenu project={menu.project} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
          {(projects.data ?? []).map((project) => (
            <button
              key={project.id}
              disabled={!project.exists}
              onClick={() => openProject(project.id)}
              // The same menu as the project's card on the home page.
              onContextMenu={(event) => {
                event.preventDefault();
                const known = overview.data?.find((item) => item.id === project.id);
                setMenu({ project: { id: project.id, name: project.name, root: project.root, muted: known?.muted, paused: known?.paused }, x: event.clientX, y: event.clientY });
              }}
              title={project.root}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              <FolderGit2 size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.waiting > 0 && <span className="rounded-full bg-severity-warning px-1.5 text-[10px] font-semibold text-background">{project.waiting}</span>}
              {project.running > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-[10px]" title={`${project.running} running`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> {project.running}
                </span>
              )}
            </button>
          ))}
          <OpenFolderDialog open={picking} onOpenChange={setPicking} />
        </div>

        {tasks.length > 0 && (
          <div className="mt-2 px-2">
            <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Hub tasks</div>
            {tasks.map((session) => (
              <button
                key={session.id}
                onClick={() => go({ kind: "session", id: session.id })}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  view.kind === "session" && view.id === session.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Wrench size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <StatusDot session={session} />
              </button>
            ))}
          </div>
        )}
      </div>

      <ClaudeInfo />
    </aside>
  );
}

const COLLAPSED_KEY = "clauder-hub:global-sidebar-collapsed";

/**
 * The frame #/global opens in: its own sidebar, and the global page or a hub
 * task's terminal (a global channel is set up in one).
 */
export function GlobalShell() {
  const view = useStore((state) => state.view);
  const left = usePersistentWidth("clauder-hub:sidebar-width", 280, { min: 220, max: 480 });
  const right = usePersistentWidth("clauder-hub:live-panel-width", 260, { min: 200, max: 420 });
  const livePanel = useLivePanel((state) => state.open);
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
    document.title = "Clauder Hub · Global";
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // The preference just does not persist.
    }
  }, [collapsed]);
  // Going anywhere closes the drawer, and so does growing past md.
  useEffect(() => setDrawer(false), [view, wide]);

  const content =
    view.kind === "session" ? (
      <SessionView key={view.id} id={view.id} />
    ) : view.kind === "page" && view.page === "inbox" ? (
      <GlobalInbox />
    ) : view.kind === "page" && view.page === "hub-settings" ? (
      <HubSettingsPage />
    ) : view.kind === "page" && view.page === "channels" ? (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-6xl p-5">
          <ChannelsPage global />
        </div>
      </div>
    ) : (
      <GlobalProjects />
    );

  return (
    <div className="flex h-screen overflow-hidden">
      {wide && <GlobalSidebar width={left.width} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />}
      {wide && !collapsed && <ResizeHandle onDrag={left.resizeBy} onReset={left.reset} />}
      {!wide && (
        <>
          {drawer && <div className="fixed inset-0 z-40 bg-foreground/40 animate-in fade-in-0" onClick={() => setDrawer(false)} />}
          <div inert={!drawer} className={cn("fixed inset-y-0 left-0 z-40 flex border-r bg-background transition-transform duration-200", drawer ? "translate-x-0 shadow-xl" : "-translate-x-full")}>
            <GlobalSidebar width="min(280px, 85vw)" collapsed={false} onToggle={() => setDrawer(false)} drawer />
          </div>
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
            <Button variant="ghost" size="icon" onClick={() => setDrawer(true)} aria-label="Open menu" title="Menu">
              <Menu size={16} />
            </Button>
            <LogoLink />
            <div className="min-w-0 flex-1">
              <TitleLink />
              <div className="text-[11px] text-muted-foreground">Global</div>
            </div>
          </div>
        )}
        <ClaudeBanner />
        <div className="min-h-0 flex-1">{content}</div>
      </main>
      {wide && livePanel && <ResizeHandle onDrag={(delta) => right.resizeBy(-delta)} onReset={right.reset} />}
      {wide && livePanel && <LivePanel width={right.width} />}
    </div>
  );
}
