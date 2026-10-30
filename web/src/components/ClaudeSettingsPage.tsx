import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { attempt, useLive } from "../lib/store";
import type { ClaudeSettings } from "../lib/types";
import { Section } from "./Charts";
import { PageHeader } from "./Page";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";
import { Select, SelectItem } from "./ui/Select";
import { Textarea } from "./ui/Textarea";

const MODE_LABEL: Record<string, string> = {
  manual: "Manual: ask before edits and commands",
  default: "Default (older name of Manual)",
  acceptEdits: "Accept edits: ask only for commands",
  plan: "Plan: read and plan, change nothing",
  auto: "Auto: a classifier decides what to ask",
  dontAsk: "Don't ask: deny what is not allowed",
  bypassPermissions: "Bypass: never ask",
};

const MODELS = ["default", "fable", "opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** "" is the person's own Claude Code setting: the hub then passes no flag. */
const OWN = "";

/**
 * How the hub starts `claude`. Each choice becomes a flag on sessions started
 * from now on; a running session keeps what it started with. Saved on change.
 */
export function ClaudeSettingsPage() {
  const live = useLive(() => api.claudeSettings(), []);
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  // The text fields keep their own draft and save when left, not on each key.
  const [model, setModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [addDirs, setAddDirs] = useState("");

  useEffect(() => {
    if (!live.data) return;
    const loaded = live.data.settings;
    setSettings(loaded);
    setModel(loaded.model);
    setFallbackModel(loaded.fallbackModel);
    setAddDirs(loaded.addDirs.join("\n"));
  }, [live.data]);

  const save = async (patch: Partial<ClaudeSettings>) => {
    const saved = await attempt(() => api.saveClaudeSettings(patch), "Saved. New sessions use it.");
    if (saved) setSettings(saved);
  };

  const modes = live.data?.permissionModes ?? [];
  const efforts = live.data?.efforts ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <PageHeader group="Settings" title="Claude settings" description="How the hub starts claude. Applies to sessions started from now on; empty keeps your own Claude Code setting." />
        {settings && (
          <>
            <Section title="Permissions" description="Which mode a session starts in.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sessions you open" hint="New session, resumes and hub tasks.">
                  <Select value={settings.permissionMode} onValueChange={(permissionMode) => void save({ permissionMode })}>
                    <SelectItem value={OWN}>Your Claude Code setting</SelectItem>
                    {modes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {MODE_LABEL[mode] ?? mode}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
                <Field label="Unattended runs" hint="Cron, webhook and queued runs. Their questions go to the channels.">
                  <Select value={settings.runPermissionMode} onValueChange={(runPermissionMode) => void save({ runPermissionMode })}>
                    <SelectItem value={OWN}>Your Claude Code setting</SelectItem>
                    {modes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {MODE_LABEL[mode] ?? mode}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title="Model" description="An alias or a full model id.">
              <datalist id="claude-models">
                {MODELS.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Model">
                  <Input list="claude-models" value={model} placeholder="Your Claude Code setting" onChange={(event) => setModel(event.target.value)} onBlur={() => model !== settings.model && void save({ model: model.trim() })} />
                </Field>
                <Field label="Fallback model" hint="Used when the model is overloaded.">
                  <Input
                    list="claude-models"
                    value={fallbackModel}
                    placeholder="None"
                    onChange={(event) => setFallbackModel(event.target.value)}
                    onBlur={() => fallbackModel !== settings.fallbackModel && void save({ fallbackModel: fallbackModel.trim() })}
                  />
                </Field>
                <Field label="Effort">
                  <Select value={settings.effort} onValueChange={(effort) => void save({ effort })}>
                    <SelectItem value={OWN}>Your Claude Code setting</SelectItem>
                    {efforts.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {effort}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title="Access" description="What else a session can reach.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Extra directories" hint="One path per line, passed as --add-dir.">
                  <Textarea
                    rows={3}
                    className="font-mono"
                    value={addDirs}
                    placeholder="C:\Source code\shared-lib"
                    onChange={(event) => setAddDirs(event.target.value)}
                    onBlur={() => addDirs !== settings.addDirs.join("\n") && void save({ addDirs: addDirs.split("\n") })}
                  />
                </Field>
                <Field label="Claude in Chrome">
                  <Select value={settings.chrome} onValueChange={(chrome) => void save({ chrome })}>
                    <SelectItem value={OWN}>Your Claude Code setting</SelectItem>
                    <SelectItem value="on">On</SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                  </Select>
                </Field>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
