import { FileText, Plug, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { attempt, useLive } from "../lib/store";
import type { DefinitionItem, Inventory, MemoryFile, Scope, Toolset } from "../lib/types";
import { FileEditor } from "./FileEditor";
import { McpCatalog } from "./McpCatalog";
import { BackToList, PageHeader } from "./Page";
import { Accordion } from "./ui/Accordion";
import { Checkbox } from "./ui/Checkbox";
import { Empty } from "./ui/Empty";
import { GlobalBadge } from "./ui/GlobalBadge";
import { Input } from "./ui/Input";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * What a session in this project is made of, one kind per page: its
 * instructions, agents, skills, commands, MCP servers, hooks and plugins, each
 * grouped by where it comes from. Claude Code merges all scopes, so all are
 * shown: yours (every project) first, then this project's, then plugins.
 */
const SCOPE_ORDER: Scope[] = ["user", "project", "local", "plugin", "built-in"];
const SCOPE_LABEL: Record<Scope, string> = {
  project: "This project (shared, in the repo)",
  local: "This project (local, only on this machine)",
  user: "You (every project)",
  plugin: "Plugins",
  "built-in": "Built into Claude Code",
};

/**
 * Global means it reaches every project on this machine: anything from
 * ~/.claude (user scope), and whatever a plugin installed at user scope brings.
 */
function isGlobal(item: { scope: Scope; plugin?: string }, plugins: Inventory["plugins"]): boolean {
  if (item.scope === "user") return true;
  return item.scope === "plugin" && plugins.find((plugin) => plugin.id === item.plugin)?.scope === "user";
}

function useInventory() {
  return useLive(() => api.inventory(), ["sessions"]);
}

/**
 * What a new session starts with: the default preset, whose toolset lists what
 * is off. MCP servers are matched to their toolset id through the catalog.
 */
function useDefaults() {
  const presets = useLive(() => api.presets(), ["jobs"]);
  const catalog = useLive(() => api.toolsetCatalog(), ["sessions"]);
  if (!presets.data || !catalog.data) return null;
  const off = presets.data.find((preset) => preset.isDefault)?.toolset ?? { agents: [], skills: [], mcp: [], plugins: [] };
  const mcpId = (name: string) => catalog.data!.find((item) => item.kind === "mcp" && item.label === name)?.id;
  return { off, mcpId };
}

/** The switch in front of an item: on means a new session has it. Saved at once into the default preset. */
function DefaultCheckbox({ defaults, kind, id, plugin }: { defaults: ReturnType<typeof useDefaults>; kind: keyof Toolset; id: string | undefined; plugin?: string }) {
  if (!defaults || !id) return null;
  const pluginOff = Boolean(plugin && defaults.off.plugins.includes(plugin));
  return (
    <Checkbox
      ariaLabel={`${id} in new sessions`}
      title={pluginOff ? `Off with its plugin ${plugin}` : "On in new sessions (default preset)"}
      disabled={pluginOff}
      checked={!pluginOff && !defaults.off[kind].includes(id)}
      onCheckedChange={(enabled) => void attempt(() => api.setDefaultItem(kind, id, enabled), `${id} ${enabled ? "on" : "off"} in new sessions.`)}
    />
  );
}

function byScope<T extends { scope: Scope }>(items: T[]): Array<[Scope, T[]]> {
  return SCOPE_ORDER.map((scope) => [scope, items.filter((item) => item.scope === scope)] as [Scope, T[]]).filter(([, list]) => list.length);
}

/**
 * A searchable list on the left, grouped by scope, and the selected item on
 * the right. Below md they take turns: the list, then the item with a way back.
 */
function MasterDetail<T extends { scope: Scope }>({
  items,
  keyOf,
  render,
  detail,
  searchText,
  empty,
  leading,
}: {
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  /** Before the name, outside its button: the default checkbox. */
  leading?: (item: T) => ReactNode;
  detail: (item: T) => ReactNode;
  searchText: (item: T) => string;
  empty: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => searchText(item).toLowerCase().includes(needle)) : items;
  }, [items, query, searchText]);
  const groups = byScope(filtered);
  const current = items.find((item) => keyOf(item) === selected) ?? groups[0]?.[1][0] ?? null;

  if (!items.length) return <Empty title={empty} className="m-5" />;
  return (
    <div className="flex min-h-0 flex-1">
      <div className={cn("w-full shrink-0 overflow-y-auto p-3 md:block md:w-60 md:border-r lg:w-80", showDetail && "hidden")}>
        <div className="relative mb-2">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${items.length}`} className="pl-6" />
        </div>
        <div className="space-y-1.5">
          {groups.map(([scope, list]) => (
            <Accordion key={scope} title={SCOPE_LABEL[scope]} badge={<StatusBadge tone="off">{list.length}</StatusBadge>} defaultOpen>
              {list.map((item) => (
                <div
                  key={keyOf(item)}
                  className={cn(
                    // Names stay in full ink whether selected or not; selection is the background.
                    "flex items-center gap-1 rounded-md",
                    leading && "pl-2",
                    current && keyOf(current) === keyOf(item) ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  {leading?.(item)}
                  <button
                    onClick={() => {
                      setSelected(keyOf(item));
                      setShowDetail(true);
                    }}
                    className="block min-w-0 flex-1 px-2 py-1.5 text-left text-foreground"
                  >
                    {render(item)}
                  </button>
                </div>
              ))}
            </Accordion>
          ))}
        </div>
        {!groups.length && <div className="px-1 text-xs text-muted-foreground">No match.</div>}
      </div>
      <div className={cn("min-w-0 flex-1 overflow-y-auto p-4 md:block md:p-5", !showDetail && "hidden")}>
        <BackToList onClick={() => setShowDetail(false)} />
        {current ? detail(current) : null}
      </div>
    </div>
  );
}

function Frame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-5 py-4">
        <PageHeader group="Project" title={title} description={description} />
      </div>
      {children}
    </div>
  );
}

const MEMORY_GROUP: Record<string, string> = { memory: "CLAUDE.md", rules: "Rule", "auto-memory": "Auto memory" };

export function InstructionsPage() {
  const files = useLive(() => api.memory(), []);
  const items = (files.data ?? []).filter((file) => file.group in MEMORY_GROUP);
  return (
    <Frame
      title="Instructions"
      description="CLAUDE.md, rules and memory that every session loads."
    >
      {files.data && (
        <MasterDetail<MemoryFile>
          items={items}
          keyOf={(item) => item.path}
          searchText={(item) => item.label}
          empty="No instruction files."
          render={(item) => (
            <div className="flex items-center gap-1.5">
              <FileText size={12} className="shrink-0" />
              <span className={cn("min-w-0 truncate font-mono text-[11px]", !item.exists && "opacity-50")}>{item.label}</span>
              {item.scope === "user" && <GlobalBadge />}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{item.exists ? MEMORY_GROUP[item.group] : "new"}</span>
            </div>
          )}
          detail={(item) => <FileEditor key={item.path} path={item.path} title={item.label} badge={item.scope === "user" ? <GlobalBadge /> : null} onSaved={files.reload} />}
        />
      )}
    </Frame>
  );
}

const DEFINITION_TEXT: Record<"agents" | "skills" | "commands", { title: string; description: string; empty: string }> = {
  agents: {
    title: "Agents",
    description: "Subagents Claude can delegate to. Ticked ones are on in new sessions.",
    empty: "No agents defined. Claude still has its built-in ones (Explore, Plan, general-purpose).",
  },
  skills: { title: "Skills", description: "Instructions Claude loads when a task matches. Ticked ones are on in new sessions.", empty: "No skills installed." },
  commands: { title: "Commands", description: "Slash commands, typed as /name.", empty: "No custom commands." },
};

export function DefinitionsPage({ kind }: { kind: "agents" | "skills" | "commands" }) {
  const inventory = useInventory();
  const defaults = useDefaults();
  const text = DEFINITION_TEXT[kind];
  return (
    <Frame title={text.title} description={text.description}>
      {inventory.data && (
        <MasterDetail<DefinitionItem>
          items={inventory.data[kind]}
          // Built-in agents have no file, so no path to tell them apart.
          keyOf={(item) => item.path || `${item.scope}:${item.name}`}
          searchText={(item) => `${item.name} ${item.description}`}
          empty={text.empty}
          // Commands have no switch: Claude Code can only turn them all off.
          leading={kind === "commands" ? undefined : (item) => <DefaultCheckbox defaults={defaults} kind={kind} id={item.name} plugin={item.plugin} />}
          render={(item) => (
            <div>
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-[11px]">{kind === "commands" ? `/${item.name}` : item.name}</span>
                {isGlobal(item, inventory.data!.plugins) && <GlobalBadge />}
              </div>
              {item.description && <div className="truncate text-[10px] text-muted-foreground">{item.description}</div>}
            </div>
          )}
          detail={(item) => (
            <div className="space-y-3">
              {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge tone="off">{item.scope}</StatusBadge>
                {item.plugin && <StatusBadge tone="off">{item.plugin}</StatusBadge>}
                {item.model && <StatusBadge tone="off">model: {item.model}</StatusBadge>}
              </div>
              {item.scope === "built-in" ? (
                <div className="space-y-1">
                  <h2 className="font-mono text-sm font-semibold">{item.name}</h2>
                  <p className="text-[11px] text-muted-foreground">Built into Claude Code, so there is no file to show or edit. It can be turned off per session in its Toolset tab, or in a preset.</p>
                </div>
              ) : (
                <FileEditor
                  key={item.path}
                  path={item.path}
                  title={kind === "commands" ? `/${item.name}` : item.name}
                  badge={isGlobal(item, inventory.data!.plugins) ? <GlobalBadge /> : null}
                  subtitle={item.path}
                  onSaved={inventory.reload}
                />
              )}
            </div>
          )}
        />
      )}
    </Frame>
  );
}

function ScopedTable<T extends { scope: Scope }>({ items, row, empty, footer }: { items: T[]; row: (item: T, index: number) => ReactNode; empty: string; footer?: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">
      {!items.length && <Empty title={empty} />}
      {byScope(items).map(([scope, list]) => (
        <Accordion key={scope} title={SCOPE_LABEL[scope]} badge={<StatusBadge tone="off">{list.length}</StatusBadge>} defaultOpen>
          <div className="divide-y rounded-md border bg-background">{list.map((item, index) => row(item, index))}</div>
        </Accordion>
      ))}
      {footer}
    </div>
  );
}

export function McpServersPage() {
  const inventory = useInventory();
  const defaults = useDefaults();
  return (
    <Frame
      title="MCP servers"
      description="Servers configured in files. claude.ai connectors are not listed."
    >
      {inventory.data && (
        <ScopedTable<Inventory["mcpServers"][number]>
          items={inventory.data.mcpServers}
          empty="No MCP servers configured in files."
          footer={<McpCatalog />}
          row={(server) => (
            <div key={`${server.scope}:${server.name}`} className={cn("flex items-center gap-2 px-3 py-2", server.disabled && "opacity-50")}>
              <DefaultCheckbox defaults={defaults} kind="mcp" id={defaults?.mcpId(server.name)} plugin={server.plugin} />
              <Plug size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-[11px]">{server.name}</span>
              {isGlobal(server, inventory.data!.plugins) && <GlobalBadge />}
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={server.target}>
                {server.target}
              </span>
              {server.disabled && <StatusBadge tone="off">disabled</StatusBadge>}
              <StatusBadge tone="off">{server.transport}</StatusBadge>
            </div>
          )}
        />
      )}
    </Frame>
  );
}

export function HooksPage() {
  const inventory = useInventory();
  return (
    <Frame
      title="Hooks"
      description="Your hooks, from settings files and plugins."
    >
      {inventory.data && (
        <ScopedTable<Inventory["hooks"][number]>
          items={inventory.data.hooks}
          empty="No hooks configured."
          row={(hook, index) => (
            <div key={index} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono">{hook.event}</span>
                {isGlobal(hook, inventory.data!.plugins) && <GlobalBadge />}
                {hook.matcher && <StatusBadge tone="off">{hook.matcher}</StatusBadge>}
                <StatusBadge tone="off">{hook.type}</StatusBadge>
                {hook.plugin && <span className="text-muted-foreground">{hook.plugin.split("@")[0]}</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={hook.summary}>
                {hook.summary}
              </div>
            </div>
          )}
        />
      )}
    </Frame>
  );
}

export function PluginsPage() {
  const inventory = useInventory();
  const defaults = useDefaults();
  const plugins = inventory.data?.plugins ?? [];
  const counts = (id: string) => {
    const of = (list: DefinitionItem[]) => list.filter((item) => item.plugin === id).length;
    const data = inventory.data!;
    const parts = [
      [of(data.agents), "agents"],
      [of(data.skills), "skills"],
      [of(data.commands), "commands"],
      [data.mcpServers.filter((item) => item.plugin === id).length, "MCP"],
      [data.hooks.filter((item) => item.plugin === id).length, "hooks"],
    ] as Array<[number, string]>;
    return parts.filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(" · ");
  };
  return (
    <Frame title="Plugins" description="Installed plugins and what each adds.">
      {inventory.data && (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {plugins.length ? (
            <div className="divide-y rounded-md border">
              {plugins.map((plugin) => (
                <div key={plugin.id} className={cn("px-3 py-2", !plugin.enabled && "opacity-50")}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* A plugin turned off in settings is off everywhere; there is nothing to default. */}
                    {plugin.enabled && <DefaultCheckbox defaults={defaults} kind="plugins" id={plugin.id} />}
                    <span className="min-w-0 break-all font-mono text-[11px]">{plugin.id}</span>
                    {plugin.scope === "user" && <GlobalBadge />}
                    <StatusBadge tone="off">v{plugin.version}</StatusBadge>
                    <StatusBadge tone={plugin.enabled ? "success" : "off"}>{plugin.enabled ? "enabled" : "disabled"}</StatusBadge>
                    <StatusBadge tone="off">{plugin.scope}</StatusBadge>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{counts(plugin.id) || "Nothing this hub can list."}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No plugins installed." />
          )}
        </div>
      )}
    </Frame>
  );
}
