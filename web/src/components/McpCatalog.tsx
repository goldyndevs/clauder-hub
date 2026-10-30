import { Check, ExternalLink, KeyRound, LogIn, Plus, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { useLive } from "../lib/store";
import type { McpCatalogEntry } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { Section } from "./Charts";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";

/** What adding one asks of the person, in a word: a browser sign-in, some values, or nothing. */
function setupOf(entry: McpCatalogEntry): { icon: typeof KeyRound; text: string } {
  if (entry.params.length) {
    const names = entry.params.filter((param) => param.required).map((param) => param.name);
    return { icon: KeyRound, text: names.length ? `Needs ${names.join(", ")}` : "Optional settings" };
  }
  if (entry.auth === "oauth") return { icon: LogIn, text: "Sign in after adding" };
  return { icon: Check, text: "Nothing to set up" };
}

/**
 * Well-known MCP servers, one click from being added. Adding opens a hub task
 * (a Claude session) whose note lists exactly what that server needs, so the
 * values are asked for in conversation and the command is run after a yes.
 */
export function McpCatalog() {
  const catalog = useLive(() => api.mcpCatalog(), ["mcp"]);
  const { starting, start } = usePurpose();
  if (!catalog.data?.length) return null;

  return (
    <Section
      title="Recommended"
      description="Common servers. Adding one opens a hub task that asks for what it needs."
      action={
        <Button disabled={starting} onClick={() => void start("add-mcp")} title="Opens a hub task to add any MCP server">
          <Sparkles size={12} /> Add another server
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {catalog.data.map((entry) => {
          const setup = setupOf(entry);
          return (
            <div key={entry.id} className="flex flex-col rounded-md border p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold">{entry.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{entry.vendor}</div>
                </div>
                <StatusBadge tone="off">{entry.category}</StatusBadge>
              </div>
              <p className="mt-1.5 line-clamp-2 flex-1 text-[11px] text-muted-foreground" title={entry.description}>
                {entry.description}
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[10px] text-muted-foreground" title={setup.text}>
                  <setup.icon size={11} className="shrink-0" /> <span className="truncate">{setup.text}</span>
                </span>
                <a href={entry.docs} target="_blank" rel="noreferrer" title="Docs" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <ExternalLink size={12} />
                </a>
                {entry.installed ? (
                  <StatusBadge tone="success" icon={Check}>
                    added
                  </StatusBadge>
                ) : (
                  <Button className="shrink-0 bg-white text-neutral-900 hover:bg-white/85" disabled={starting} onClick={() => void start("add-mcp", entry.id)}>
                    <Plus size={12} /> Add
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
