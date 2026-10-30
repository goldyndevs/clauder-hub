import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { SessionSetup as Setup } from "../lib/types";
import { useConfirm } from "./Confirm";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { MarkdownBox } from "./ui/MarkdownBox";

const same = (a: Setup, b: Setup) => JSON.stringify(a) === JSON.stringify(b);
// One empty row is always open to type into when there are none yet.
const withRow = (setup: Setup): Setup => (setup.variables.length ? setup : { ...setup, variables: [{ name: "", value: "" }] });

/**
 * What the person sets up for this session only: notes and named values,
 * appended to its system prompt. Claude reads the prompt at start-up, so saving
 * restarts a live session on the same conversation.
 */
export function SessionSetup({ sessionId, live, current }: { sessionId: string; live: boolean; current: Setup }) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Setup>(() => withRow(current));

  useEffect(() => setDraft(withRow(current)), [JSON.stringify(current)]);
  // Rows without a name are dropped on save, so they do not count as a change.
  // Trimmed as the server stores it, so a stray space is not an unsaved change that saving never clears.
  const cleaned = {
    notes: draft.notes.trim(),
    variables: draft.variables.map((item) => ({ name: item.name.trim(), value: item.value.trim() })).filter((item) => item.name),
  };
  const dirty = !same(cleaned, current);

  const setVariable = (index: number, patch: Partial<Setup["variables"][number]>) =>
    setDraft({ ...draft, variables: draft.variables.map((item, at) => (at === index ? { ...item, ...patch } : item)) });

  const save = () =>
    confirm({
      title: live ? "Save and restart this session?" : "Save this setup?",
      description: live ? "Restarts it on the same conversation." : "Applies on the next resume.",
      confirmLabel: live ? "Save & restart" : "Save",
      tone: live ? "destructive" : "primary",
      run: async () => {
        await api.setSessionSetup(sessionId, cleaned);
        useStore.getState().notify(live ? "Restarting with the new setup." : "Saved.");
      },
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-sm font-semibold">Setup</h2>
          <p className="truncate text-[11px] text-muted-foreground">For this session only, appended to its system prompt. Applies at start-up.</p>
        </div>
        <div className="flex gap-1.5">
          <Button disabled={!dirty} onClick={() => setDraft(withRow(current))}>
            Reset
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            {live ? "Save & restart" : "Save"}
          </Button>
        </div>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3>
        <MarkdownBox rows={10} defaultMode="edit" value={draft.notes} onChange={(notes) => setDraft({ ...draft, notes })} />
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Names</h3>
        <p className="text-[11px] text-muted-foreground">Short names you use in this session and what each stands for, e.g. OUT → C:\reports\2026.</p>
        {draft.variables.map((item, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input className="w-48 shrink-0 font-mono" placeholder="Name" value={item.name} onChange={(event) => setVariable(index, { name: event.target.value })} />
            <Input className="min-w-0 flex-1" placeholder="What it stands for" value={item.value} onChange={(event) => setVariable(index, { value: event.target.value })} />
            <Button variant="ghost" size="icon" title="Remove" onClick={() => setDraft({ ...draft, variables: draft.variables.filter((_, at) => at !== index) })}>
              <X size={13} />
            </Button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setDraft({ ...draft, variables: [...draft.variables, { name: "", value: "" }] })}>
          <Plus size={12} /> Add a name
        </Button>
      </section>
    </div>
  );
}
