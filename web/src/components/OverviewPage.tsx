import { api } from "../lib/api";
import { compact, totalTokens } from "../lib/format";
import { useLive, useStore, type Page } from "../lib/store";
import type { Inventory } from "../lib/types";
import { ToolGroups } from "./Activity";
import { BarList, DayColumns, Section, StatTile, TokenTiles } from "./Charts";
import { PageHeader } from "./Page";

/** Everything this project's sessions have done; what they are made of is one click away, under Project. */
export function OverviewPage() {
  const stats = useLive(() => api.stats(), ["sessions", "transcript"]);
  const inventory = useLive(() => api.inventory(), ["sessions"]);
  const sessions = useStore((state) => state.sessions);
  const s = stats.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <PageHeader group="Operation" title="Overview" description="Stats from this project's Claude Code transcripts." />

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Sessions" value={String(s?.sessions ?? "-")} />
          <StatTile label="Live now" value={String(sessions.filter((item) => item.live).length)} />
          <StatTile label="Waiting on you" value={String(sessions.filter((item) => item.status === "waiting").length)} />
          <StatTile label="Tool calls" value={s ? compact(Object.values(s.tools).reduce((n, item) => n + item.count, 0)) : "-"} />
        </div>
        {s && <TokenTiles tokens={s.tokens} />}

        {s && (
          <>
            <div className="grid gap-3 lg:grid-cols-3">
              <Section title="Output tokens per day" className="lg:col-span-2">
                <DayColumns days={s.byDay} valueOf={(tokens) => tokens.output} label="output tokens" />
              </Section>
              <Section title="Tokens by model">
                <BarList rows={Object.entries(s.byModel).filter(([, t]) => totalTokens(t) > 0).map(([model, tokens]) => ({ key: model, label: model, value: totalTokens(tokens) }))} />
              </Section>
            </div>
            <ToolGroups tools={s.tools} />
            <div className="grid gap-3 lg:grid-cols-2">
              <Section title="Subagents by type" description="How often each was spawned, with its own tokens.">
                <BarList
                  rows={Object.entries(s.agents).map(([type, value]) => ({ key: type, label: type, value: value.count, sublabel: `${compact(totalTokens(value.tokens))} tok` }))}
                  format={String}
                  empty="No subagents yet."
                />
              </Section>
              <Section title="Skills & commands">
                <BarList rows={Object.entries(s.skills).map(([name, count]) => ({ key: name, label: name, value: count }))} format={String} empty="No skills used yet." />
              </Section>
            </div>
          </>
        )}
        {stats.error && <div className="text-xs text-severity-critical">{stats.error}</div>}

        {inventory.data && <ProjectGlance inventory={inventory.data} />}
      </div>
    </div>
  );
}

const GLANCE: Array<{ page: Page; label: string; count: (inventory: Inventory) => number }> = [
  { page: "agents", label: "Agents", count: (inventory) => inventory.agents.length },
  { page: "skills", label: "Skills", count: (inventory) => inventory.skills.length },
  { page: "commands", label: "Commands", count: (inventory) => inventory.commands.length },
  { page: "mcp-servers", label: "MCP servers", count: (inventory) => inventory.mcpServers.length },
  { page: "hooks", label: "Hooks", count: (inventory) => inventory.hooks.length },
  { page: "plugins", label: "Plugins", count: (inventory) => inventory.plugins.filter((plugin) => plugin.enabled).length },
];

function ProjectGlance({ inventory }: { inventory: Inventory }) {
  const go = useStore((state) => state.go);
  return (
    <Section title="What sessions can reach for" description="All scopes together: this project, your user config and enabled plugins. Open one under Project.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
        {GLANCE.map((item) => (
          <button key={item.page} onClick={() => go({ kind: "page", page: item.page })} className="rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted">
            <div className="text-[11px] text-muted-foreground">{item.label}</div>
            <div className="text-lg font-semibold tabular-nums">{item.count(inventory)}</div>
          </button>
        ))}
      </div>
    </Section>
  );
}
