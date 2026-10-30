import { Pencil, Plus, Radio, Send, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { projectApi } from "../lib/project";
import { cn } from "../lib/cn";
import { attempt, useLive } from "../lib/store";
import type { Channel } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { Section } from "./Charts";
import { useConfirm } from "./Confirm";
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

/**
 * Where a session can reach a person. Every enabled channel gets everything
 * it subscribes to. Channels are added and changed in a Claude session for
 * that purpose, tokens included.
 */
export function ChannelsPage({ global = false }: { global?: boolean }) {
  const live = useLive(() => api.channels(), ["channels"]);
  const { starting, start } = usePurpose();
  const confirm = useConfirm();
  // This computer has its own switch above; the list is for the platforms that reach a person elsewhere.
  const remote = (live.data?.channels ?? []).filter((channel) => channel.kind !== "device");
  const kinds = live.data?.kinds ?? [];

  return (
    // On #/global it is one section of a page that scrolls on its own.
    <div className={global ? "" : "h-full overflow-y-auto"}>
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
          <Button variant="primary" className="shrink-0" disabled={starting} onClick={() => void start("create-channel")} title="Opens a Claude session to connect a channel">
            <Plus size={12} /> Add channel
          </Button>
        </div>

        {/* Each project already notifies this computer; the global channels are the remote ones. */}
        {live.data && !global && <DeviceNotifications channel={live.data.channels.find((channel) => channel.kind === "device")} kinds={live.data.interactionKinds} />}

        <Section title="Channels" description="Send /help to the Telegram bot, or !help in the Slack channel, for the commands: new session, run, sessions, summary, stop, queue.">
          {remote.length ? (
            <div className="divide-y rounded-md border">
              {remote.map((channel) => (
                <div key={channel.id} className="flex items-center gap-2 px-3 py-2.5">
                  <Radio size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="min-w-0 truncate font-medium">{channel.name}</span>
                      <StatusBadge tone="off">{kinds.find((kind) => kind.kind === channel.kind)?.label ?? channel.kind}</StatusBadge>
                      <StatusBadge tone={channel.status.ok ? "success" : channel.enabled ? "warning" : "off"}>{channel.status.ok ? "connected" : channel.enabled ? "not connected" : "off"}</StatusBadge>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {channel.status.detail} · {channel.kinds.map((kind) => KIND_LABEL[kind] ?? kind).join(", ")}
                    </div>
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
                  <Button variant="ghost" size="icon" title="Edit with Claude" onClick={() => void start("edit-channel", channel.id)}>
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Delete" onClick={() =>
                      void confirm({
                        title: `Remove '${channel.name}'?`,
                        description: "Sessions stop reaching you there.",
                        confirmLabel: "Remove",
                        tone: "destructive",
                        run: () => api.deleteChannel(channel.id),
                      })
                    }>
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Empty variant="inline" title="No channels yet. Without one, questions wait in the dashboard's inbox and the terminal." />
          )}
        </Section>
      </div>
    </div>
  );
}

const DEVICE_DEFAULT_KINDS = ["permission", "question", "mcp"];

/**
 * Notifications on the computer the hub runs on: the operating system's own
 * (a Windows toast, macOS Notification Center, notify-send), sent by the hub,
 * so they arrive with every browser window closed. A switch, plus which kinds
 * of question are worth interrupting for.
 */
function DeviceNotifications({ channel, kinds }: { channel: Channel | undefined; kinds: string[] }) {
  const on = Boolean(channel?.enabled);
  const chosen = new Set(channel?.kinds ?? DEVICE_DEFAULT_KINDS);
  const save = (patch: { enabled?: boolean; kinds?: string[] }) =>
    attempt(() =>
      api.saveChannel({
        id: channel?.id,
        kind: "device",
        name: "This computer",
        config: {},
        enabled: patch.enabled ?? on,
        kinds: patch.kinds ?? [...chosen],
      }),
    );
  return (
    <Section
      title="This computer"
      description="System notifications from the hub itself; they arrive even with the browser closed."
      action={
        <div className="flex items-center gap-1.5">
          {on && channel && (
            <Button variant="ghost" size="icon" title="Send a test notification" onClick={() => void attempt(() => api.testChannel(channel.id), "Test notification sent.")}>
              <Send size={13} />
            </Button>
          )}
          <button
            role="switch"
            aria-checked={on}
            aria-label="Notify on this computer"
            onClick={() => void save({ enabled: !on })}
            className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-foreground/20")}
          >
            <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all", on ? "left-[18px]" : "left-0.5")} />
          </button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-muted-foreground">Notify for</span>
        {kinds.map((kind) => (
          <button
            key={kind}
            disabled={!on}
            onClick={() => void save({ kinds: chosen.has(kind) ? [...chosen].filter((item) => item !== kind) : [...chosen, kind] })}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              chosen.has(kind) ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {KIND_LABEL[kind] ?? kind}
          </button>
        ))}
        {on && channel && !channel.status.ok && <span className="text-[11px] text-severity-critical">{channel.status.detail}</span>}
      </div>
    </Section>
  );
}
