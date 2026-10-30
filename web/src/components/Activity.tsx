import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { compact, groupTools, mcpParts, totalTokens, when } from "../lib/format";
import type { SessionDetail, Subagent, ToolCall, ToolCounts } from "../lib/types";
import { BarList, Section, TokenTiles } from "./Charts";

/** Tool calls in their four groups; MCP calls are grouped once more, by server. */
export function ToolGroups({ tools }: { tools: ToolCounts }) {
  const groups = groupTools(tools);
  const servers: Record<string, { count: number; errors: number; tools: string[] }> = {};
  for (const item of groups.mcp) {
    const { server, tool } = mcpParts(item.name);
    const entry = (servers[server] ??= { count: 0, errors: 0, tools: [] });
    entry.count += item.count;
    entry.errors += item.errors;
    entry.tools.push(`${tool} ×${item.count}`);
  }
  const rows = (list: Array<{ name: string; count: number; errors: number }>) =>
    list.map((item) => ({ key: item.name, label: item.name, value: item.count, note: item.errors ? `${item.errors} failed` : undefined }));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Section title={`Built-in tools (${groups["built-in"].reduce((n, item) => n + item.count, 0)})`}>
        <BarList rows={rows(groups["built-in"])} format={String} />
      </Section>
      <Section title={`MCP servers (${groups.mcp.reduce((n, item) => n + item.count, 0)})`} description="Calls grouped by server; hover a bar for its tools.">
        <BarList
          rows={Object.entries(servers).map(([server, value]) => ({
            key: server,
            label: server,
            value: value.count,
            note: value.errors ? `${value.errors} failed` : undefined,
            sublabel: value.tools.slice(0, 3).join(", "),
          }))}
          format={String}
          empty="No MCP calls."
        />
      </Section>
    </div>
  );
}

function SubagentRow({ agent }: { agent: Subagent }) {
  const [open, setOpen] = useState(false);
  const calls = Object.values(agent.tools).reduce((n, item) => n + item.count, 0);
  return (
    <div className="rounded-md border">
      <button className="flex w-full items-center gap-2 px-2.5 py-2 text-left" onClick={() => setOpen(!open)} style={{ paddingLeft: 10 + (agent.depth - 1) * 16 }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Bot size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[11px]">{agent.agentType}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agent.description}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {calls} calls · {compact(totalTokens(agent.tokens))} tok
        </span>
      </button>
      {open && (
        <div className="grid gap-3 border-t p-3 md:grid-cols-2">
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <div>Model: {agent.model ?? "inherited"}{agent.fork && " · fork"}</div>
            <div>
              {when(agent.startedAt)} → {when(agent.lastAt)}
            </div>
            <div>
              Output {compact(agent.tokens.output)} · cache read {compact(agent.tokens.cacheRead)}
            </div>
          </div>
          <BarList rows={Object.entries(agent.tools).map(([name, value]) => ({ key: name, label: name, value: value.count }))} format={String} limit={6} empty="No tool calls." />
          {agent.recent.length > 0 && (
            <div className="md:col-span-2">
              <CallList calls={agent.recent.slice(-10)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CallList({ calls }: { calls: ToolCall[] }) {
  return (
    <div className="divide-y rounded-md border">
      {[...calls].reverse().map((call) => (
        <div key={call.id} className="flex items-baseline gap-2 px-2.5 py-1.5 text-[11px]">
          <span className="hidden w-20 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground sm:block">{call.ts ? new Date(call.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</span>
          <span className={cn("max-w-[60%] shrink-0 truncate font-mono sm:max-w-none", call.error && "text-severity-critical")}>{call.name.startsWith("mcp__") ? call.name.replace(/^mcp__/, "mcp:") : call.name}</span>
          <span className="min-w-0 truncate text-muted-foreground">{call.summary}</span>
        </div>
      ))}
    </div>
  );
}

export function Activity({ data }: { data: SessionDetail }) {
  const detail = data.detail;
  if (!detail) return <div className="p-6 text-xs text-muted-foreground">Claude has not written anything for this session yet.</div>;
  const totals = detail.totals;
  const calls = Object.values(totals.tools).reduce((n, item) => n + item.count, 0);
  return (
    <div className="space-y-3">
      <TokenTiles tokens={totals.tokens} />
      <div className="grid gap-3 lg:grid-cols-3">
        <Section title="Tokens by model">
          <BarList rows={Object.entries(totals.tokensByModel).filter(([, t]) => totalTokens(t) > 0).map(([model, tokens]) => ({ key: model, label: model, value: totalTokens(tokens) }))} />
        </Section>
        <Section title="Skills & commands">
          <BarList rows={Object.entries(detail.skills).map(([name, count]) => ({ key: name, label: name, value: count }))} format={String} empty="No skills used." />
        </Section>
        <Section title="Shape">
          <div className="space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Prompts</span><span className="tabular-nums">{data.session.turns ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Tool calls (all agents)</span><span className="tabular-nums">{calls}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Subagents</span><span className="tabular-nums">{detail.subagents.length}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Branch</span><span className="font-mono text-[11px]">{data.session.gitBranch ?? "-"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Permission mode</span><span>{data.session.permissionMode ?? "-"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Claude Code</span><span>{data.session.version ?? "-"}</span></div>
          </div>
        </Section>
      </div>
      <ToolGroups tools={totals.tools} />
      <Section title={`Subagents (${detail.subagents.length})`} description="Each one's own tokens and calls; a fork's inherited context is counted once, on its parent.">
        {detail.subagents.length ? (
          <div className="space-y-1.5">
            {detail.subagents.map((agent) => (
              <SubagentRow key={agent.id} agent={agent} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No subagents.</div>
        )}
      </Section>
      <Section title="Recent calls (main thread)">
        {detail.recent.length ? <CallList calls={detail.recent.slice(-40)} /> : <div className="text-xs text-muted-foreground">No tool calls yet.</div>}
      </Section>
    </div>
  );
}
