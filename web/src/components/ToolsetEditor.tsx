import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/cn";
import type { CatalogItem, Toolset } from "../lib/types";
import { Accordion } from "./ui/Accordion";
import { GlobalBadge } from "./ui/GlobalBadge";
import { Input } from "./ui/Input";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * Turns agents, skills, MCP servers and plugins on and off for one session or
 * preset. A switch that is on means available; the toolset only records what
 * is off. Turning a plugin off takes everything it brings with it, so those
 * items show as off and cannot be turned back on one by one.
 */
const SECTIONS: Array<{ kind: keyof Toolset; title: string }> = [
  { kind: "plugins", title: "Plugins" },
  { kind: "agents", title: "Agents" },
  { kind: "skills", title: "Skills" },
  { kind: "mcp", title: "MCP servers" },
];

function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        on ? "bg-primary" : "bg-foreground/20",
      )}
    >
      <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all", on ? "left-3.5" : "left-0.5")} />
    </button>
  );
}

export function ToolsetEditor({ catalog, value, onChange }: { catalog: CatalogItem[]; value: Toolset; onChange: (next: Toolset) => void }) {
  const [query, setQuery] = useState("");
  const globalPlugins = useMemo(() => new Set(catalog.filter((item) => item.kind === "plugins" && item.scope === "user").map((item) => item.id)), [catalog]);
  const isGlobal = (item: CatalogItem) => item.scope === "user" || (item.scope === "plugin" && Boolean(item.plugin && globalPlugins.has(item.plugin)));

  const toggle = (item: CatalogItem) => {
    const list = value[item.kind];
    onChange({ ...value, [item.kind]: list.includes(item.id) ? list.filter((id) => id !== item.id) : [...list, item.id] });
  };
  const setAll = (kind: keyof Toolset, on: boolean, items: CatalogItem[]) => {
    const ids = new Set(items.map((item) => item.id));
    const kept = value[kind].filter((id) => !ids.has(id));
    onChange({ ...value, [kind]: on ? kept : [...kept, ...ids] });
  };

  const needle = query.trim().toLowerCase();
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter" className="pl-6" />
      </div>
      {SECTIONS.map(({ kind, title }) => {
        const all = catalog.filter((item) => item.kind === kind);
        if (!all.length) return null;
        const items = needle ? all.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(needle)) : all;
        const off = all.filter((item) => value[kind].includes(item.id) || (item.plugin && value.plugins.includes(item.plugin))).length;
        return (
          <Accordion
            key={kind}
            title={title}
            badge={<StatusBadge tone={off ? "warning" : "off"}>{off ? `${off} of ${all.length} off` : `${all.length} on`}</StatusBadge>}
            defaultOpen
          >
            <div className="mb-1.5 flex gap-3 text-[11px] text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => setAll(kind, true, items)}>
                All on
              </button>
              <button className="hover:text-foreground" onClick={() => setAll(kind, false, items)}>
                All off
              </button>
            </div>
            {items.length ? (
              <div className="divide-y rounded-md border bg-background">
                {items.map((item) => {
                  const viaPlugin = Boolean(item.plugin && value.plugins.includes(item.plugin));
                  const on = !viaPlugin && !value[kind].includes(item.id);
                  return (
                    <div key={item.id} className="flex items-center gap-2.5 px-3 py-1.5">
                      <Switch on={on} disabled={viaPlugin} onToggle={() => toggle(item)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate font-mono text-[11px] text-foreground">{item.label}</span>
                          {isGlobal(item) && <GlobalBadge />}
                        </div>
                        {item.description && <div className="truncate text-[10px] text-muted-foreground">{item.description}</div>}
                      </div>
                      {viaPlugin ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">off with its plugin</span>
                      ) : (
                        !item.leavesContext && (
                          <span className="shrink-0 text-[10px] text-muted-foreground" title="Turning this off blocks its use; Claude may still see it listed.">
                            blocks use only
                          </span>
                        )
                      )}
                      <span className="hidden w-16 shrink-0 text-right text-[10px] text-muted-foreground sm:block">{item.scope}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No match.</div>
            )}
          </Accordion>
        );
      })}
    </div>
  );
}

/** How many things a toolset turns off, for a one-line summary. */
export function toolsetCount(toolset: Toolset): number {
  return toolset.agents.length + toolset.skills.length + toolset.mcp.length + toolset.plugins.length;
}
