import { Monitor, Pencil, Plus, Radio, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { projectApi } from "../lib/project";
import { cn } from "../lib/cn";
import { attempt, useLive, useStore } from "../lib/store";
import type { Channel } from "../lib/types";
import { Section } from "./Charts";
import { useConfirm } from "./Confirm";
import { ChannelForm } from "./HubForms";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyId";
import { Empty } from "./ui/Empty";
import { StatusBadge } from "./ui/StatusBadge";

const KIND_LABEL: Record<string, string> = {
  permission: "Permission requests",
  question: "Questions",
  turn: "End of each turn",
  mcp: "MCP suggestions",
  done: "Task done",
};

const HIGHLIGHT_EVENT = "clauder:highlight-notifications";
let highlightPending = false;

/** Opens the channels page with the all-channels switch flashed, as the muted bell next to the version does. */
export function showNotificationsSwitch(): void {
  highlightPending = true;
  useStore.getState().go({ kind: "page", page: "channels" });
  window.dispatchEvent(new Event(HIGHLIGHT_EVENT));
}

function Switch({ on, label, onToggle, className }: { on: boolean; label: string; onToggle: () => void; className?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-foreground/20", className)}
    >
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

/**
 * Where a session can reach a person. One switch and one choice of what is
 * worth a notification hold for every channel; this computer is one of them.
 * Channels are added and changed in a Claude session for that purpose,
 * tokens included.
 */
export function ChannelsPage({ global = false }: { global?: boolean }) {
  const live = useLive(() => api.channels(), ["channels"]);
  const [form, setForm] = useState<{ channel?: Channel } | null>(null);
  const confirm = useConfirm();
  const kinds = live.data?.kinds ?? [];
  const paused = live.data?.paused ?? false;
  const chosen = new Set(live.data?.notifyKinds ?? []);
  // This computer is a card of its own in each project; the global channels are the remote ones.
  const device = live.data?.channels.find((channel) => channel.kind === "device");
  const remote = (live.data?.channels ?? []).filter((channel) => channel.kind !== "device");

  const master = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const show = () => {
      if (!highlightPending || !master.current) return;
      highlightPending = false;
      master.current.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlash(true);
      window.setTimeout(() => setFlash(false), 2200);
    };
    show();
    window.addEventListener(HIGHLIGHT_EVENT, show);
    return () => window.removeEventListener(HIGHLIGHT_EVENT, show);
  }, [live.data !== null]);

  const toggleKind = (kind: string) => void attempt(() => api.setNotifyKinds(chosen.has(kind) ? [...chosen].filter((item) => item !== kind) : [...chosen, kind]));

  return (
    // On #/global it is one section of a page that scrolls on its own.
    <div className={global ? "" : "h-full overflow-y-auto"}>
      {/* This computer is made by the hub itself, never added. */}
      {form && <ChannelForm channel={form.channel} kinds={form.channel ? kinds : kinds.filter((kind) => kind.kind !== "device")} onClose={() => setForm(null)} />}
      <div className={cn("space-y-4", !global && "p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{global ? "Every project" : "Settings"}</div>
            <h1 className="text-base font-semibold">{global ? "Global channels" : "Channels"}</h1>
            {global ? (
              <p className="truncate text-xs text-muted-foreground" title="One bot for every project: their questions arrive here, named after the project, and /projects, /use pick one.">
                One bot for every project: their questions arrive here, named after the project.
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground" title="Where sessions reach you. A reply goes back into the session.">Where sessions reach you. A reply goes back into the session.</p>
            )}
          </div>
          <Button variant="primary" className="shrink-0" onClick={() => setForm({})}>
            <Plus size={12} /> Add channel
          </Button>
        </div>

        {live.data && (
          <Section
            title="Notifications"
            description={paused ? "Paused: no channel hears of anything; questions still wait in the inbox." : "For every channel below, this computer included."}
            action={
              <div
                ref={master}
                className={cn("flex items-center gap-2 rounded-full py-0.5 pl-2.5 pr-0.5 transition-shadow", flash && "ring-2 ring-primary ring-offset-2 ring-offset-background animate-pulse")}
              >
                {/* Says what the switch is doing, so its position needs no guessing. */}
                <span className={cn("text-[11px] font-medium", paused ? "text-severity-warning" : "text-muted-foreground")}>{paused ? "Paused on every channel" : "On for every channel"}</span>
                <Switch on={!paused} label={paused ? "Turn notifications back on" : "Pause notifications on every channel"} onToggle={() => void attempt(() => api.setNotificationsPaused(!paused))} />
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-muted-foreground">Notify for</span>
              {(live.data.interactionKinds ?? []).map((kind) => (
                <button
                  key={kind}
                  disabled={paused}
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    chosen.has(kind) ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {KIND_LABEL[kind] ?? kind}
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title="Channels" description="Send /help to the Telegram bot, or !help in the Slack channel, for the commands: new session, run, sessions, summary, stop, queue.">
          {live.data && (!global || remote.length) ? (
            <div className="divide-y rounded-md border">
              {!global && <DeviceCard channel={device} />}
              {remote.map((channel) => (
                <div key={channel.id} className="flex items-center gap-2 px-3 py-2.5">
                  <Radio size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="min-w-0 truncate font-medium">{channel.name}</span>
                      <StatusBadge tone="off">{kinds.find((kind) => kind.kind === channel.kind)?.label ?? channel.kind}</StatusBadge>
                      <StatusBadge tone={channel.status.ok ? "success" : channel.enabled ? "warning" : "off"}>{channel.status.ok ? "connected" : channel.enabled ? "not connected" : "off"}</StatusBadge>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{channel.status.detail}</div>
                    {channel.kind === "http" && (
                      // Replies to a webhook channel come back here, with the reply secret in x-clauder-secret.
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <span className="truncate font-mono">POST {`${location.origin}${projectApi()}/channels/${channel.id}/reply`}</span>
                        <CopyButton text={`${location.origin}${projectApi()}/channels/${channel.id}/reply`} />
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" size="icon" title="Send a test message" onClick={() => void attempt(() => api.testChannel(channel.id), "Test message sent.")}>
                    <Send size={13} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Edit" onClick={() => setForm({ channel })}>
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete"
                    onClick={() =>
                      void confirm({
                        title: `Remove '${channel.name}'?`,
                        description: "Sessions stop reaching you there.",
                        confirmLabel: "Remove",
                        tone: "destructive",
                        run: () => api.deleteChannel(channel.id),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            live.data && <Empty variant="inline" title="No channels yet. Without one, questions wait in the dashboard's inbox and the terminal." />
          )}
        </Section>
      </div>
    </div>
  );
}

/**
 * Notifications on the computer the hub runs on: the operating system's own
 * (a Windows toast, macOS Notification Center, notify-send), sent by the hub,
 * so they arrive with every browser window closed. Built in: switched, never
 * edited or removed.
 */
function DeviceCard({ channel }: { channel: Channel | undefined }) {
  const on = Boolean(channel?.enabled);
  const toggle = () =>
    attempt(() => api.saveChannel({ id: channel?.id, kind: "device", name: "This computer", config: {}, enabled: !on, kinds: channel?.kinds }));
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <Monitor size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="min-w-0 truncate font-medium">This computer</span>
          <StatusBadge tone="off">System notifications</StatusBadge>
          <StatusBadge tone={on && channel?.status.ok ? "success" : on ? "warning" : "off"}>{on ? (channel?.status.ok ? "on" : "not working") : "off"}</StatusBadge>
        </div>
        <div className={cn("mt-0.5 truncate text-[11px]", on && channel && !channel.status.ok ? "text-severity-critical" : "text-muted-foreground")}>
          {on && channel && !channel.status.ok ? channel.status.detail : "From the hub itself; they arrive even with the browser closed."}
        </div>
      </div>
      {on && channel && (
        <Button variant="ghost" size="icon" title="Send a test notification" onClick={() => void attempt(() => api.testChannel(channel.id), "Test notification sent.")}>
          <Send size={13} />
        </Button>
      )}
      <span className="text-[11px] font-medium text-muted-foreground">{on ? "On" : "Off"}</span>
      <Switch on={on} label={on ? "Stop notifying on this computer" : "Notify on this computer"} onToggle={() => void toggle()} />
    </div>
  );
}
