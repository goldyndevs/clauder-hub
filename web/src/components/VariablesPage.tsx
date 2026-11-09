import { CalendarClock, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { when } from "../lib/format";
import { attempt, useLive, useStore } from "../lib/store";
import type { Variable } from "../lib/types";
import { useConfirm } from "./Confirm";
import { PageHeader } from "./Page";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyId";
import { Empty } from "./ui/Empty";
import { Input } from "./ui/Input";
import { Popover } from "./ui/Popover";
import { StatusBadge } from "./ui/StatusBadge";

const DAY = 86_400_000;
const SOON_DAYS = 7;

const SCOPE_HINT: Record<Variable["scope"], string> = {
  user: "Every project on this machine",
  project: "Shared with the repository: committed with it, usually",
  local: "This project on this machine only",
};

/** Where a file is, with the home folder shortened. */
function shortFile(file: string): string {
  const home = file.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+|\/(?:home|Users)\/[^/]+)/)?.[1];
  return home ? `~${file.slice(home.length)}` : file;
}

function expiryState(variable: Variable): { tone: "critical" | "warning" | "success" | "off"; text: string; title: string } | null {
  const source = variable.expirySource === "token" ? "read from the token" : variable.expirySource === "check" ? "told by the service" : "noted by you";
  if (variable.expiresAt) {
    const left = Date.parse(variable.expiresAt) - Date.now();
    const title = `Expires ${when(variable.expiresAt)}, ${source}`;
    if (left <= 0) return { tone: "critical", text: "expired", title };
    const days = Math.ceil(left / DAY);
    if (days <= SOON_DAYS) return { tone: "warning", text: `expires in ${days} day${days > 1 ? "s" : ""}`, title };
    return { tone: "success", text: `expires ${new Date(variable.expiresAt).toLocaleDateString()}`, title };
  }
  if (variable.check?.ok) return { tone: "success", text: "works", title: `${variable.check.detail} Checked ${when(variable.check.at)}.` };
  return null;
}

/** The value as shown, the real one on request; the reveal is fetched each time and never kept. */
function ValueCell({ variable }: { variable: Variable }) {
  const [real, setReal] = useState<string | null>(null);
  const toggle = async () => {
    if (real !== null) return setReal(null);
    const result = await attempt(() => api.variableValue(variable.id));
    if (result) setReal(result.value ?? "(not set)");
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className={cn("min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-[11px]", real === null && variable.secret && "tracking-wider")} title={real ?? variable.shown}>
        {real ?? (variable.shown || "(empty)")}
      </code>
      {variable.reference && (
        <StatusBadge tone={variable.resolved ? "success" : "warning"}>{variable.resolved ? "set here" : "not set here"}</StatusBadge>
      )}
      {(variable.secret || variable.reference) && (
        <Button variant="ghost" size="icon" title={real === null ? "Show the value" : "Hide it"} aria-label={real === null ? "Show the value" : "Hide the value"} onClick={() => void toggle()}>
          {real === null ? <Eye size={12} /> : <EyeOff size={12} />}
        </Button>
      )}
      {real !== null && <CopyButton text={real} />}
    </div>
  );
}

/** A date to be reminded of, for a token whose expiry nothing can read. */
function ExpiryNote({ variable, onSaved }: { variable: Variable; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const noted = variable.expirySource === "noted" && variable.expiresAt ? variable.expiresAt.slice(0, 10) : "";
  const [date, setDate] = useState(noted);
  const save = async (value: string | null) => {
    const saved = await attempt(() => api.setVariableExpiry(variable.id, value ? `${value}T00:00:00` : null), value ? "Noted." : "Cleared.");
    if (saved) {
      setOpen(false);
      onSaved();
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDate(noted);
      }}
      align="end"
      className="w-60 space-y-2 p-3"
      trigger={
        <Button variant="ghost" size="icon" title="Note when it expires" aria-label="Note when it expires">
          <CalendarClock size={12} />
        </Button>
      }
    >
      <div className="text-xs font-medium">When does it expire?</div>
      <div className="text-[11px] text-muted-foreground">The page warns {SOON_DAYS} days before. A date read from the token or the service comes first.</div>
      <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      <div className="flex justify-end gap-1.5">
        {noted && <Button onClick={() => void save(null)}>Clear</Button>}
        <Button variant="primary" disabled={!date} onClick={() => void save(date)}>
          Save
        </Button>
      </div>
    </Popover>
  );
}

/** What the rotate dialog's field holds, read when the write is confirmed. */
function NewValueField({ holder, name }: { holder: { value: string }; name: string }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        type={shown ? "text" : "password"}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          holder.value = event.target.value;
        }}
        placeholder={`New value for ${name}`}
        className="font-mono"
      />
      <Button type="button" variant="ghost" size="icon" aria-label={shown ? "Hide" : "Show"} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={13} /> : <Eye size={13} />}
      </Button>
    </div>
  );
}

function VariableRow({ variable, onChanged }: { variable: Variable; onChanged: () => void }) {
  const confirm = useConfirm();
  const [checking, setChecking] = useState(false);
  const expiry = expiryState(variable);
  const failed = variable.check && !variable.check.ok;

  const rotate = () => {
    const holder = { value: "" };
    void confirm({
      title: `${variable.secret ? "Rotate" : "Edit"} ${variable.name}`,
      description: `${variable.where}, in ${shortFile(variable.file)}`,
      body: (
        <div className="space-y-2">
          <NewValueField holder={holder} name={variable.name} />
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            <li>Written straight into the file; nothing else in it changes.</li>
            {variable.scope === "project" && <li className="text-severity-warning">This file is shared with the repository: a secret here gets committed. A local-scope server keeps it on this machine.</li>}
            <li>Sessions started from now on use it; a running one keeps the old value until it is restarted.</li>
          </ul>
        </div>
      ),
      confirmLabel: "Write to file",
      run: async () => {
        if (!holder.value) throw new Error("Type the new value first.");
        await api.saveVariable(variable.id, holder.value);
        useStore.getState().notify(`Written to ${shortFile(variable.file)}.`);
        onChanged();
      },
    });
  };

  const check = async () => {
    setChecking(true);
    await attempt(() => api.checkVariable(variable.id));
    setChecking(false);
    onChanged();
  };

  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="truncate font-mono text-xs" title={variable.name}>
          {variable.name}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={variable.where}>
          {variable.where}
          {variable.kind && ` · ${variable.kind}`}
        </div>
      </div>
      <ValueCell variable={variable} />
      <div className="flex shrink-0 items-center justify-end gap-1">
        {failed && (
          <span title={`${variable.check!.detail} Checked ${when(variable.check!.at)}.`}>
            <StatusBadge tone="critical">not accepted</StatusBadge>
          </span>
        )}
        {expiry && (
          <span title={expiry.title}>
            <StatusBadge tone={expiry.tone}>{expiry.text}</StatusBadge>
          </span>
        )}
        {variable.checkable && (
          <Button variant="ghost" size="icon" disabled={checking} title="Ask its service whether it still works (and, for GitHub, when it expires)" aria-label="Check" onClick={() => void check()}>
            {checking ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
          </Button>
        )}
        {variable.secret && !variable.reference && variable.expirySource !== "token" && <ExpiryNote variable={variable} onSaved={onChanged} />}
        {variable.editable && (
          <Button variant="ghost" title="Write a new value into the file" onClick={rotate}>
            {variable.secret ? "Rotate" : "Edit"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The env and headers Claude Code hands its MCP servers, and the env of every
 * settings file, per file: masked, shown on request, rotated in place, and
 * when a token runs out wherever that can be known.
 */
export function VariablesPage() {
  const live = useLive(() => api.variables(), ["files"]);
  const [query, setQuery] = useState("");
  const list = (live.data ?? []).filter((item) => !query || `${item.name} ${item.where} ${item.file}`.toLowerCase().includes(query.toLowerCase()));
  const files = [...new Set(list.map((item) => item.file))];
  const attention = (live.data ?? []).filter((item) => {
    const state = expiryState(item);
    return (item.check && !item.check.ok) || state?.tone === "critical" || state?.tone === "warning";
  }).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <PageHeader
          group="Project"
          title="Variables"
          description="What Claude Code is given through its files: MCP servers' env and headers, and settings env."
          action={
            <Button onClick={live.reload} title="Read the files again">
              <RefreshCw size={12} /> Reload
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name, server or file" className="max-w-xs" />
          {attention > 0 && <StatusBadge tone="warning">{attention} need attention</StatusBadge>}
        </div>
        {live.data && !live.data.length && (
          <Empty title="No variables yet." hint="None of .mcp.json, ~/.claude.json or the settings files gives Claude Code an env value or a header for this project." />
        )}
        {live.data?.length && !list.length ? <Empty variant="inline" title="Nothing matches the filter." /> : null}
        {files.map((file) => {
          const items = list.filter((item) => item.file === file);
          const scopes = [...new Set(items.map((item) => item.scope))];
          return (
            <section key={file} className="rounded-md border">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
                <KeyRound size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono text-[11px]" title={file}>
                  {shortFile(file)}
                </span>
                {scopes.map((scope) => (
                  <span key={scope} title={SCOPE_HINT[scope]}>
                    <StatusBadge tone="off">{scope}</StatusBadge>
                  </span>
                ))}
                <CopyButton text={file} className="ml-auto" />
              </div>
              <div className="divide-y">
                {items.map((item) => (
                  <VariableRow key={item.id} variable={item} onChanged={live.reload} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
