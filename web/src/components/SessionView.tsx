import { Bell, BookOpen, ExternalLink, Pencil, Play, Square, Trash2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { compact, totalTokens, when } from "../lib/format";
import { attempt, openWindow, useStore } from "../lib/store";
import type { Interaction, SessionDetail } from "../lib/types";
import { Activity } from "./Activity";
import { useConfirm } from "./Confirm";
import { InteractionCard } from "./InteractionCard";
import { useSessionActions } from "./SessionActions";
import { SessionSetup } from "./SessionSetup";
import { SessionToolset } from "./SessionToolset";
import { StatusDot } from "./Sidebar";
import { TerminalView } from "./TerminalView";
import { Button } from "./ui/Button";
import { Markdown } from "./ui/Markdown";
import { CopyButton } from "./ui/CopyId";
import { Empty } from "./ui/Empty";
import { SideDrawer } from "./ui/SideDrawer";
import { StatusBadge } from "./ui/StatusBadge";

type Tab = "terminal" | "activity" | "setup" | "toolset" | "interactions";

export function SessionView({ id }: { id: string }) {
  const session = useStore((state) => state.sessions.find((item) => item.id === id));
  const transcriptTick = useStore((state) => state.transcriptTicks[id] ?? 0);
  const interactionsTick = useStore((state) => state.ticks.interactions);
  const [data, setData] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<Tab>("terminal");
  const [missing, setMissing] = useState(false);
  const windowed = useStore((state) => state.windowed);
  const confirm = useConfirm();
  const actions = useSessionActions();

  // Opening a session opens its terminal: one that is not running is resumed straight away.
  // Decided once per visit, so stopping it here does not bring it back on its own.
  const [opening, setOpening] = useState<"idle" | "starting" | "failed">("idle");
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !session) return;
    decided.current = true;
    if (session.live) return;
    setOpening("starting");
    api.resumeSession(id).then(
      () => setOpening("idle"),
      (error: Error) => {
        setOpening("failed");
        useStore.getState().notify(error.message, "error");
      },
    );
  }, [id, session]);

  useEffect(() => {
    setData(null);
    setMissing(false);
    setTab("terminal");
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    api.session(id).then(
      (value) => !cancelled && setData(value),
      () => !cancelled && setMissing(true),
    );
    return () => {
      cancelled = true;
    };
  }, [id, transcriptTick, interactionsTick, session?.status, session?.terminalId]);

  if (!session && missing) return <Empty title="This session is gone." hint="Its transcript may have been cleaned up by Claude Code." className="m-6" />;
  if (!session) return <div className="p-6 text-xs text-muted-foreground">Loading...</div>;

  const open = (data?.interactions ?? []).filter((item) => item.status === "open");
  const resume = () => attempt(() => api.resumeSession(id));
  const kill = () =>
    confirm({
      title: "Stop this session?",
      description: "The conversation is kept for a later resume.",
      confirmLabel: "Stop",
      tone: "destructive",
      run: () => api.killSession(id),
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot session={session} />
            <h1 className="truncate text-sm font-semibold">{session.title}</h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <StatusBadge tone={session.status === "waiting" ? "warning" : session.status === "running" ? "success" : session.status === "done" ? "on" : "off"}>{session.status}</StatusBadge>
            <StatusBadge tone="off">{session.origin === "external" ? "started in a terminal" : `from ${session.origin}`}</StatusBadge>
            {session.category && <StatusBadge tone="off">category: {session.category}</StatusBadge>}
            {session.purpose && (
              <StatusBadge tone="on" icon={Wrench}>
                hub task: {session.purpose.title}
              </StatusBadge>
            )}
            <span>{when(session.startedAt)}</span>
            {session.tokens && <span>· {compact(totalTokens(session.tokens))} tokens</span>}
            {/* The full Claude Code session id, the one `claude --resume` takes. */}
            <span className="inline-flex min-w-0 items-center gap-1 font-mono" title="Claude Code session id">
              <span className="truncate">{session.id}</span>
              <CopyButton text={session.id} />
            </span>
          </div>
        </div>
        {/* Below sm the labelled buttons keep only their icon; the label stays as title and aria-label. */}
        <div className="flex shrink-0 gap-1.5">
          <Button variant="ghost" size="icon" title="Rename" aria-label="Rename" onClick={() => void actions.rename(session)}>
            <Pencil size={13} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={session.live ? "Stop and delete permanently" : "Delete permanently"}
            aria-label="Delete permanently"
            onClick={() => void actions.remove(session)}
          >
            <Trash2 size={13} />
          </Button>
          {!windowed && (
            <Button variant="ghost" title="Open in a window of its own" aria-label="New window" onClick={() => openWindow({ kind: "session", id })}>
              <ExternalLink size={12} /> <span className="hidden sm:inline">New window</span>
            </Button>
          )}
          {session.live ? (
            <Button variant="muted" title="Stop" aria-label="Stop" onClick={() => void kill()}>
              <Square size={12} /> <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button variant="primary" title="Resume here" aria-label="Resume here" onClick={() => void resume()}>
              <Play size={12} /> <span className="hidden sm:inline">Resume here</span>
            </Button>
          )}
        </div>
      </header>

      {/* One row that scrolls sideways when it does not fit, never a second line. */}
      <div className="no-scrollbar flex gap-1 overflow-x-auto border-b px-2 sm:px-4">
        {(
          [
            ["terminal", "Terminal"],
            ["setup", "Setup"],
            ["activity", "Activity"],
            ["toolset", "Toolset"],
            ["interactions", `Interactions${data?.interactions.length ? ` (${data.interactions.length})` : ""}`],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn("shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors", tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Kept mounted while another tab is shown, so the terminal does not reconnect each time. */}
        <div className={cn("relative h-full p-2 sm:p-3", tab !== "terminal" && "hidden")}>
          {/* The terminal's corner: what it waits on, and a hub task's note, each in a drawer. */}
          <div className="absolute right-4 top-4 z-10 flex gap-1.5 sm:right-5 sm:top-5">
            <WaitingDrawer items={open} />
            {session.purpose && data?.purposeNote && <PurposeDrawer title={session.purpose.title} note={data.purposeNote} />}
          </div>
          {session.terminalId ? (
            <TerminalView key={session.terminalId} terminalId={session.terminalId} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
              {opening === "starting" ? (
                <div className="text-xs text-muted-foreground">Starting the terminal...</div>
              ) : (
                // Shown only when the automatic start failed, or after the session was stopped here.
                <Button variant="primary" size="md" onClick={() => void resume()}>
                  <Play size={13} /> Start the terminal again
                </Button>
              )}
              {session.done && (
                <div className="card max-w-lg p-3 text-xs">
                  <div className="font-medium">{session.done.summary}</div>
                  {Object.entries(session.done.deliverables ?? {}).map(([key, value]) => (
                    <div key={key} className="mt-1 text-[11px]">
                      <span className="font-medium">{key}: </span>
                      <span className="break-all text-muted-foreground">{typeof value === "string" ? value : JSON.stringify(value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {tab === "activity" && <div className="h-full overflow-y-auto p-4">{data ? <Activity data={data} /> : <div className="text-xs text-muted-foreground">Loading...</div>}</div>}
        {tab === "setup" && (
          <div className="h-full overflow-y-auto p-4">
            {data ? <SessionSetup sessionId={id} live={session.live} current={data.setup} /> : <div className="text-xs text-muted-foreground">Loading...</div>}
          </div>
        )}
        {tab === "toolset" && (
          <div className="h-full overflow-y-auto p-4">
            {data ? <SessionToolset sessionId={id} live={session.live} current={data.toolset} /> : <div className="text-xs text-muted-foreground">Loading...</div>}
          </div>
        )}
        {tab === "interactions" && (
          <div className="h-full space-y-2 overflow-y-auto p-4">
            {data?.interactions.length ? (
              data.interactions.map((item) => <InteractionCard key={item.id} interaction={item} />)
            ) : (
              <Empty title="Nothing asked yet." hint="Permission requests, questions, ends of turns and MCP suggestions from this session land here and on every channel." />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A configuration session says what it is for: the purpose, every parameter
 * with an example, samples and the API Claude uses. The same note is in the
 * session's system prompt, so both sides read the same thing. A button in the
 * terminal's top-right corner opens it in a drawer from the right.
 */
function PurposeDrawer({ title, note }: { title: string; note: string }) {
  return (
    <SideDrawer
      title={title}
      icon={<Wrench size={14} className="shrink-0 text-primary" />}
      badge={<StatusBadge tone="on">hub task</StatusBadge>}
      description="Parameters, samples and API of this hub task."
      trigger={
        <Button variant="primary" className="shadow-md" title="What this hub task is for: parameters, samples, API">
          <BookOpen size={12} /> <span className="hidden sm:inline">Params & samples</span>
        </Button>
      }
    >
      {/* The note opens with its own "# Purpose" heading, which the drawer's title already says. */}
      <Markdown className="text-xs">{note.replace(/^# .*\n+/, "")}</Markdown>
    </SideDrawer>
  );
}

/**
 * What the session waits on (questions, permissions, the end of a turn, an MCP
 * suggestion), kept out of the terminal's way: a button in its top-right corner,
 * there only while something waits, opens the cards in a drawer. The drawer
 * closes by itself once the last one is answered.
 */
function WaitingDrawer({ items }: { items: Interaction[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !items.length) setOpen(false);
  }, [open, items.length]);
  if (!items.length) return null;
  return (
    <SideDrawer
      open={open}
      onOpenChange={setOpen}
      title={`${items.length} waiting on you`}
      icon={<Bell size={14} className="shrink-0 text-severity-warning" />}
      description="Questions and requests this session is waiting on."
      trigger={
        <Button className="bg-severity-warning text-background shadow-md hover:bg-severity-warning/90" title="What this session is waiting on">
          <Bell size={12} className="animate-status-pulse" /> {items.length} <span className="hidden sm:inline">waiting</span>
        </Button>
      }
    >
      <div className="space-y-2">
        {items.map((item) => (
          <InteractionCard key={item.id} interaction={item} />
        ))}
      </div>
    </SideDrawer>
  );
}
