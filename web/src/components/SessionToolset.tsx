import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useLive, useStore } from "../lib/store";
import type { Toolset } from "../lib/types";
import { useConfirm } from "./Confirm";
import { ToolsetEditor, toolsetCount } from "./ToolsetEditor";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Select, SelectItem } from "./ui/Select";

const same = (a: Toolset, b: Toolset) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One session's toolset. Claude Code reads it at start-up only, so applying a
 * change to a live session restarts it on the same conversation; a stopped one
 * keeps the change for its next resume.
 */
export function SessionToolset({ sessionId, live, current }: { sessionId: string; live: boolean; current: Toolset }) {
  const confirm = useConfirm();
  const catalog = useLive(() => api.toolsetCatalog(), []);
  const presets = useLive(() => api.presets(), ["jobs"]);
  const [draft, setDraft] = useState<Toolset>(current);
  const presetName = useRef("");

  useEffect(() => setDraft(current), [JSON.stringify(current)]);
  const dirty = !same(draft, current);

  const apply = () =>
    confirm({
      title: live ? "Apply and restart this session?" : "Save this toolset?",
      description: live
        ? "Restarts it on the same conversation."
        : "Applies on the next resume.",
      confirmLabel: live ? "Apply & restart" : "Save",
      tone: live ? "destructive" : "primary",
      run: async () => {
        await api.setSessionToolset(sessionId, draft);
        useStore.getState().notify(live ? "Restarting with the new toolset." : "Saved.");
      },
    });

  const saveAsPreset = () => {
    presetName.current = "";
    return confirm({
      title: "Save as a preset",
      description: "Reusable by jobs and new sessions.",
      body: <Input autoFocus placeholder="Preset name, e.g. Frontend only" onChange={(event) => (presetName.current = event.target.value)} />,
      confirmLabel: "Save preset",
      run: async () => {
        await api.savePreset({ name: presetName.current, toolset: draft });
        useStore.getState().notify("Preset saved.");
        presets.reload();
      },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-sm font-semibold">Toolset</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {toolsetCount(current) ? `${toolsetCount(current)} turned off for this session.` : "Everything is on."} Applies at start-up.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.data && presets.data.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                const preset = presets.data?.find((item) => item.id === id);
                if (preset) setDraft(preset.toolset);
              }}
              className="w-40"
            >
              <SelectItem value="">Use a preset...</SelectItem>
              {presets.data.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                  {preset.isDefault ? " (default)" : ""}
                </SelectItem>
              ))}
            </Select>
          )}
          <Button onClick={() => void saveAsPreset()}>Save as preset</Button>
          {dirty && <Button onClick={() => setDraft(current)}>Discard</Button>}
          <Button variant="primary" disabled={!dirty} onClick={() => void apply()}>
            {live ? "Apply & restart" : "Save"}
          </Button>
        </div>
      </div>
      {catalog.data ? <ToolsetEditor catalog={catalog.data} value={draft} onChange={setDraft} /> : <div className="text-xs text-muted-foreground">Loading...</div>}
    </div>
  );
}
