import { Layers, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePurpose } from "../lib/usePurpose";
import { cn } from "../lib/cn";
import { attempt, useLive, useStore } from "../lib/store";
import type { Preset } from "../lib/types";
import { useConfirm } from "./Confirm";
import { BackToList, PageHeader } from "./Page";
import { ToolsetEditor, toolsetCount } from "./ToolsetEditor";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Empty } from "./ui/Empty";
import { Input } from "./ui/Input";
import { StatusBadge } from "./ui/StatusBadge";

const EMPTY: Omit<Preset, "id"> = { name: "", toolset: { agents: [], skills: [], mcp: [], plugins: [] }, isDefault: false };

/** Named toolsets: what is turned off, reused by jobs and, for the default one, by every new session. */
export function PresetsPage() {
  const presets = useLive(() => api.presets(), ["jobs"]);
  const catalog = useLive(() => api.toolsetCatalog(), []);
  const { starting, start } = usePurpose();
  const [selected, setSelected] = useState<string | "new" | null>(null);
  // Below md the list and the editor take turns.
  const [showDetail, setShowDetail] = useState(false);
  const choose = (id: string | "new" | null) => {
    setSelected(id);
    setShowDetail(id !== null);
  };
  const list = presets.data ?? [];
  const current = selected === "new" ? null : (list.find((item) => item.id === selected) ?? list[0] ?? null);
  const creating = selected === "new" || (!list.length && presets.data !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-5 py-4">
        <PageHeader
          group="Settings"
          title="Toolset presets"
          description="Named sets of agents, skills, MCP servers and plugins to turn off."
          action={
            <Button variant="primary" disabled={starting} onClick={() => void start("create-preset")} title="Opens a Claude session to describe the preset">
              <Plus size={12} /> New preset
            </Button>
          }
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("w-full shrink-0 space-y-0.5 overflow-y-auto p-3 md:block md:w-56 md:border-r lg:w-72", showDetail && "hidden")}>
          {list.map((preset) => (
            <button
              key={preset.id}
              onClick={() => choose(preset.id)}
              className={cn("block w-full rounded-md px-2 py-1.5 text-left text-foreground", current?.id === preset.id && !creating ? "bg-muted" : "hover:bg-muted/60")}
            >
              <div className="flex items-center gap-1.5">
                <Layers size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-xs">{preset.name}</span>
                {preset.isDefault && <StatusBadge tone="on">default</StatusBadge>}
              </div>
              <div className="truncate pl-[18px] text-[10px] text-muted-foreground">{toolsetCount(preset.toolset) ? `${toolsetCount(preset.toolset)} turned off` : "everything on"}</div>
            </button>
          ))}
          {!list.length && <Empty variant="inline" title="No presets yet." />}
        </div>
        <div className={cn("min-w-0 flex-1 overflow-y-auto p-4 md:block md:p-5", !showDetail && "hidden")}>
          <BackToList onClick={() => setShowDetail(false)} />
          {catalog.data && (creating || current) ? (
            <PresetEditor
              key={creating ? "new" : current!.id}
              preset={creating ? EMPTY : current!}
              catalog={catalog.data}
              onSaved={(id) => {
                presets.reload();
                setSelected(id);
              }}
              onDeleted={() => {
                presets.reload();
                choose(null);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PresetEditor({
  preset,
  catalog,
  onSaved,
  onDeleted,
}: {
  preset: Omit<Preset, "id"> & { id?: string };
  catalog: Parameters<typeof ToolsetEditor>[0]["catalog"];
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const { starting, start } = usePurpose();
  const [draft, setDraft] = useState(preset);
  useEffect(() => setDraft(preset), [preset]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(preset);

  const save = async () => {
    const saved = await attempt(() => api.savePreset(draft), "Saved.");
    if (saved) onSaved(saved.id);
  };
  const remove = () =>
    confirm({
      title: `Delete the preset '${preset.name}'?`,
      description: "Jobs using it fall back to the default.",
      confirmLabel: "Delete",
      tone: "destructive",
      run: async () => {
        await api.deletePreset(preset.id!);
        useStore.getState().notify("Deleted.");
        onDeleted();
      },
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Preset name" className="max-w-xs" size="md" />
          <Checkbox label="Default for new sessions and jobs" checked={draft.isDefault} onCheckedChange={(value) => setDraft({ ...draft, isDefault: value })} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {preset.id && (
            <Button variant="ghost" disabled={starting} onClick={() => void start("edit-preset", preset.id)} title="Describe the change to Claude instead of flipping switches">
              <Sparkles size={12} /> Edit with Claude
            </Button>
          )}
          {preset.id && (
            <Button variant="ghost" onClick={() => void remove()}>
              <Trash2 size={12} /> Delete
            </Button>
          )}
          {dirty && preset.id && <Button onClick={() => setDraft(preset)}>Discard</Button>}
          <Button variant="primary" disabled={!draft.name.trim() || (!dirty && Boolean(preset.id))} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
      <ToolsetEditor catalog={catalog} value={draft.toolset} onChange={(toolset) => setDraft({ ...draft, toolset })} />
    </div>
  );
}
