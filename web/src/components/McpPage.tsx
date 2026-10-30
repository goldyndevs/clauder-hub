import { Download, ExternalLink, Plug, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { cn } from "../lib/cn";
import { attempt, useLive, useStore } from "../lib/store";
import type { Suggestion } from "../lib/types";
import { Section } from "./Charts";
import { useConfirm } from "./Confirm";
import { PageHeader } from "./Page";
import { Button } from "./ui/Button";
import { Empty } from "./ui/Empty";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * MCP servers a blocked session asked for. Installing runs the suggestion's
 * `claude mcp add` at project scope, only when a person says so, and the
 * session that asked is then resumed to load it.
 */
export function McpSuggestionsPage() {
  const suggestions = useLive(() => api.suggestions(), ["mcp"]);
  const enabled = useLive(() => api.mcpSuggestionsEnabled(), ["mcp"]);
  const on = Boolean(enabled.data?.enabled);
  const go = useStore((state) => state.go);
  const pending = (suggestions.data ?? []).filter((item) => item.status === "suggested");
  const past = (suggestions.data ?? []).filter((item) => item.status !== "suggested");

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <PageHeader
          group="Settings"
          title="MCP suggestions"
          description="Servers that blocked sessions asked for. Nothing installs without you."
          action={
            <Button onClick={() => go({ kind: "page", page: "mcp-servers" })}>
              <Plug size={12} /> Configured servers
            </Button>
          }
        />

        <Section
          title="Suggest MCP servers"
          description="When on, sessions are told they may stop and ask for a missing MCP server. Off: that part of the system prompt is left out. Applies to sessions started from now on."
          action={
            <button
              role="switch"
              aria-checked={on}
              aria-label="Suggest MCP servers"
              disabled={!enabled.data}
              onClick={() => void attempt(() => api.setMcpSuggestionsEnabled(!on), on ? "MCP suggestions off." : "MCP suggestions on.")}
              className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-foreground/20")}
            >
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all", on ? "left-[18px]" : "left-0.5")} />
            </button>
          }
        >
          {null}
        </Section>

        <Section title={`Waiting (${pending.length})`}>
          {pending.length ? (
            <div className="space-y-2">
              {pending.map((item) => (
                <SuggestionCard key={item.id} suggestion={item} />
              ))}
            </div>
          ) : (
            <Empty variant="inline" title="No session is waiting on an MCP server." />
          )}
        </Section>

        {past.length > 0 && (
          <Section title="History">
            <div className="space-y-2">
              {past.map((item) => (
                <SuggestionCard key={item.id} suggestion={item} />
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const go = useStore((state) => state.go);
  const confirm = useConfirm();
  const tone = suggestion.status === "installed" ? "success" : suggestion.status === "failed" ? "critical" : suggestion.status === "suggested" ? "warning" : "off";

  const install = () =>
    confirm({
      title: `Install '${suggestion.name}'?`,
      description: "Adds it to this project's .mcp.json.",
      body: (
        <div className="space-y-2">
          <pre className="whitespace-pre-wrap rounded bg-muted p-3 font-mono text-[11px]">{suggestion.runs}</pre>
          <p className="text-[11px] text-muted-foreground">If it succeeds, the session that asked is restarted on the same conversation so the server loads, and is told to continue.</p>
        </div>
      ),
      confirmLabel: "Run it",
      run: async () => {
        const result = await api.installSuggestion(suggestion.id);
        useStore
          .getState()
          .notify(result.status === "installed" ? "Installed; the session is resuming." : "The install failed; see its output.", result.status === "installed" ? "info" : "error");
      },
    });

  const skip = () =>
    confirm({
      title: `Carry on without '${suggestion.name}'?`,
      description: "The session continues without it.",
      confirmLabel: "Skip it",
      run: () => api.skipSuggestion(suggestion.id),
    });

  const remove = () =>
    confirm({
      title: "Remove this suggestion from the history?",
      confirmLabel: "Remove",
      tone: "destructive",
      run: () => api.deleteSuggestion(suggestion.id),
    });

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Plug size={14} className="shrink-0" />
        <span className="min-w-0 break-all text-xs font-semibold">{suggestion.name}</span>
        <StatusBadge tone={tone}>{suggestion.status}</StatusBadge>
        <button className="text-[11px] text-muted-foreground hover:underline" onClick={() => go({ kind: "session", id: suggestion.sessionId })}>
          from session {suggestion.sessionId.slice(0, 8)}
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">{ago(suggestion.createdAt)}</span>
      </div>
      <div className="mt-1.5 break-words text-xs text-muted-foreground">{suggestion.reason}</div>
      <pre className="mt-1.5 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{suggestion.runs ?? suggestion.command}</pre>
      {suggestion.refused && <div className="mt-1 text-[11px] text-severity-critical">{suggestion.refused}</div>}
      {suggestion.output && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono text-[10px] text-muted-foreground">{suggestion.output}</pre>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {suggestion.status === "suggested" && (
          <>
            <Button variant="primary" disabled={!suggestion.runs} onClick={() => void install()}>
              <Download size={12} /> Install & resume
            </Button>
            <Button onClick={() => void skip()}>
              <X size={12} /> Skip
            </Button>
          </>
        )}
        {suggestion.docs && (
          <a href={suggestion.docs} target="_blank" rel="noreferrer">
            <Button variant="ghost">
              <ExternalLink size={12} /> Docs
            </Button>
          </a>
        )}
        {suggestion.status !== "suggested" && (
          <Button variant="ghost" className="ml-auto" onClick={() => void remove()}>
            <Trash2 size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}
