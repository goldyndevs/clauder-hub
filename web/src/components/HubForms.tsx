import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { attempt, useLive } from "../lib/store";
import type { Category, Channel, ChannelKindInfo, Job, JobParam, PurposeKind } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Select, SelectItem } from "./ui/Select";
import { Textarea } from "./ui/Textarea";

/**
 * The forms for what the hub configures. Each can be handed to Claude instead
 * (bottom left): a session for that purpose opens with what was filled in so
 * far, and Claude carries on from there.
 */
function FormDialog({
  title,
  description,
  purpose,
  targetId,
  draft,
  canSave,
  onSave,
  onClose,
  children,
  maxWidth = "max-w-lg",
}: {
  title: string;
  description?: string;
  purpose: PurposeKind;
  targetId?: string;
  /** What goes to Claude: the form's values, secrets left out. */
  draft: () => Record<string, unknown>;
  canSave: boolean;
  /** Resolves true once saved, so the form closes. */
  onSave: () => Promise<boolean>;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  const { starting, start } = usePurpose();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    const done = await onSave();
    setSaving(false);
    if (done) onClose();
  };
  const handOver = async () => {
    await start(purpose, targetId, draft());
    onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      maxWidth={maxWidth}
      disableOutsideClose
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" disabled={starting || saving} onClick={() => void handOver()} title="Opens a Claude session with what is filled in here; Claude asks for the rest and saves it">
            <Sparkles size={12} /> {starting ? "Opening..." : "Set up with Claude"}
          </Button>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave || saving || starting} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {children}
        {/* Enter in a one-line field saves. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** "auto" plus the project's categories. */
function CategorySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const categories = useLive(() => api.categories(), []);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectItem value="auto">auto (Claude picks)</SelectItem>
      {(categories.data ?? []).map((category) => (
        <SelectItem key={category.id} value={category.name}>
          {category.name}
        </SelectItem>
      ))}
      {value !== "auto" && categories.data && !categories.data.some((category) => category.name === value) && <SelectItem value={value}>{value}</SelectItem>}
    </Select>
  );
}

const NO_PRESET = "__default__";

// ---- Jobs ----

type ParamDraft = { name: string; label: string; type: JobParam["type"]; default: string; description: string };

const toParamDraft = (param: JobParam): ParamDraft => ({
  name: param.name,
  label: param.label ?? "",
  type: param.type,
  default: String(param.default),
  description: param.description ?? "",
});

const fromParamDraft = (param: ParamDraft): JobParam => ({
  name: param.name.trim(),
  ...(param.label.trim() ? { label: param.label.trim() } : {}),
  type: param.type,
  default: param.type === "number" ? Number(param.default) : param.type === "boolean" ? param.default === "true" : param.default,
  ...(param.description.trim() ? { description: param.description.trim() } : {}),
});

/** Create a job, or edit the one given. */
export function JobForm({ job, onClose }: { job?: Job; onClose: () => void }) {
  const presets = useLive(() => api.presets(), []);
  const [name, setName] = useState(job?.name ?? "");
  const [kind, setKind] = useState<Job["kind"]>(job?.kind ?? "cron");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 9 * * 1-5");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [category, setCategory] = useState(job?.category ?? "auto");
  const [presetId, setPresetId] = useState<string | null>(job?.presetId ?? null);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [params, setParams] = useState<ParamDraft[]>((job?.params ?? []).map(toParamDraft));

  const value = () => ({
    name: name.trim(),
    kind,
    schedule: kind === "cron" ? schedule.trim() : "",
    prompt,
    category,
    presetId,
    params: params.filter((param) => param.name.trim()).map(fromParamDraft),
    enabled,
  });
  const canSave = Boolean(name.trim() && prompt.trim() && (kind !== "cron" || schedule.trim()));
  const setParam = (index: number, patch: Partial<ParamDraft>) => setParams(params.map((param, at) => (at === index ? { ...param, ...patch } : param)));

  return (
    <FormDialog
      title={job ? `Edit ${job.name}` : "New job"}
      description="A prompt run as an unattended session, on a schedule or when its webhook is called."
      purpose={job ? "edit-job" : "create-job"}
      targetId={job?.id}
      draft={value}
      canSave={canSave}
      onSave={async () => Boolean(await attempt(() => api.saveJob({ ...(job ? { id: job.id } : {}), ...value() }), "Saved."))}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Triage Jira bugs" />
        </Field>
        <Field label="Runs">
          <Select value={kind} onValueChange={(next) => setKind(next as Job["kind"])}>
            <SelectItem value="cron">On a schedule (cron)</SelectItem>
            <SelectItem value="webhook">On demand (Run, /job, webhook)</SelectItem>
          </Select>
        </Field>
      </div>
      {kind === "cron" && (
        <Field label="Schedule" hint="Cron, 5 fields (or 6 with seconds), this machine's time zone. 0 9 * * 1-5 is 9:00 on weekdays.">
          <Input value={schedule} onChange={(event) => setSchedule(event.target.value)} className="font-mono" placeholder="0 9 * * 1-5" />
        </Field>
      )}
      <Field label="Prompt" hint="{{now}} is when it fired; {{payload}} / {{payload.field}} the webhook body; {{name}} a parameter below.">
        <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="What each run is asked to do, complete enough to work without anyone at the keyboard." />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category">
          <CategorySelect value={category} onChange={setCategory} />
        </Field>
        <Field label="Toolset preset">
          <Select value={presetId ?? NO_PRESET} onValueChange={(next) => setPresetId(next === NO_PRESET ? null : next)}>
            <SelectItem value={NO_PRESET}>The default preset</SelectItem>
            {(presets.data ?? []).map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Parameters</div>
          <Button type="button" variant="ghost" onClick={() => setParams([...params, { name: "", label: "", type: "string", default: "", description: "" }])}>
            <Plus size={12} /> Add
          </Button>
        </div>
        {params.length ? (
          params.map((param, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto_1fr_auto] items-center gap-1.5">
              <Input value={param.name} onChange={(event) => setParam(index, { name: event.target.value })} placeholder="name" className="font-mono" aria-label="Name" />
              <Input value={param.label} onChange={(event) => setParam(index, { label: event.target.value })} placeholder="Label" aria-label="Label" />
              <Select
                value={param.type}
                onValueChange={(next) => setParam(index, { type: next as JobParam["type"], default: next === "boolean" ? "false" : next === "number" ? "0" : "" })}
                className="w-24"
              >
                <SelectItem value="string">string</SelectItem>
                <SelectItem value="number">number</SelectItem>
                <SelectItem value="boolean">boolean</SelectItem>
              </Select>
              {param.type === "boolean" ? (
                <Checkbox label="default on" checked={param.default === "true"} onCheckedChange={(on) => setParam(index, { default: on ? "true" : "false" })} />
              ) : (
                <Input
                  value={param.default}
                  type={param.type === "number" ? "number" : "text"}
                  onChange={(event) => setParam(index, { default: event.target.value })}
                  placeholder="default"
                  aria-label="Default"
                />
              )}
              <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => setParams(params.filter((_, at) => at !== index))}>
                <Trash2 size={12} />
              </Button>
            </div>
          ))
        ) : (
          <div className="text-[11px] text-muted-foreground">None. A parameter is a {"{{name}}"} in the prompt that Run now asks for and cron runs take the default of.</div>
        )}
      </div>

      <Checkbox label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
    </FormDialog>
  );
}

// ---- Runs ----

/** One run put on the queue. */
export function RunForm({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState("auto");
  return (
    <FormDialog
      title="Queue a run"
      description="One unattended session, started after whatever is already queued."
      purpose="queue-run"
      draft={() => ({ prompt, category })}
      canSave={Boolean(prompt.trim())}
      onSave={async () => (await attempt(() => api.queueRun(prompt, category), "Queued.")) !== undefined}
      onClose={onClose}
    >
      <Field label="Prompt">
        <Textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="What the session is asked to do, complete enough to work without anyone at the keyboard." />
      </Field>
      <Field label="Category" hint="What the run must report before it closes.">
        <CategorySelect value={category} onChange={setCategory} />
      </Field>
    </FormDialog>
  );
}

// ---- Categories ----

/** Create a category, or edit the one given; prefill starts a new one from an example. */
export function CategoryForm({ category, prefill, onClose, onSaved }: { category?: Category; prefill?: Omit<Category, "id">; onClose: () => void; onSaved: () => void }) {
  const start = category ?? prefill;
  const [name, setName] = useState(start?.name ?? "");
  const [description, setDescription] = useState(start?.description ?? "");
  const [deliverables, setDeliverables] = useState<Category["deliverables"]>(start?.deliverables ?? [{ name: "", description: "", required: true }]);
  const value = () => ({ name: name.trim(), description: description.trim(), deliverables: deliverables.filter((item) => item.name.trim()) });
  const setItem = (index: number, patch: Partial<Category["deliverables"][number]>) => setDeliverables(deliverables.map((item, at) => (at === index ? { ...item, ...patch } : item)));

  return (
    <FormDialog
      title={category ? `Edit ${category.name}` : "New category"}
      description="What a session must report before the hub closes it."
      purpose={category ? "edit-category" : "create-category"}
      targetId={category?.id}
      draft={value}
      canSave={Boolean(name.trim()) && name.trim() !== "auto"}
      onSave={async () => {
        const saved = await attempt(() => api.saveCategory({ ...(category ? { id: category.id } : {}), ...value() }), "Saved.");
        if (saved) onSaved();
        return Boolean(saved);
      }}
      onClose={onClose}
      maxWidth="max-w-xl"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint={'Unique; "auto" is reserved.'}>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="bugfix" />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A defect fixed" />
        </Field>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Deliverables</div>
          <Button type="button" variant="ghost" onClick={() => setDeliverables([...deliverables, { name: "", description: "", required: true }])}>
            <Plus size={12} /> Add
          </Button>
        </div>
        {deliverables.map((item, index) => (
          <div key={index} className="grid grid-cols-[1fr_2fr_auto_auto] items-center gap-1.5">
            <Input value={item.name} onChange={(event) => setItem(index, { name: event.target.value })} placeholder="PR" aria-label="Deliverable" />
            <Input value={item.description} onChange={(event) => setItem(index, { description: event.target.value })} placeholder="link to the pull request" aria-label="What it is" />
            <Checkbox label="required" checked={item.required} onCheckedChange={(required) => setItem(index, { required })} />
            <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => setDeliverables(deliverables.filter((_, at) => at !== index))}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
        {!deliverables.length && <div className="text-[11px] text-muted-foreground">None: a session reports a summary and evidence of its own choosing.</div>}
      </div>
    </FormDialog>
  );
}

// ---- Channels ----

const MASK = "********";

/** Add a channel, or edit the one given. A secret already saved shows masked and is kept unless replaced. */
export function ChannelForm({ channel, kinds, onClose }: { channel?: Channel; kinds: ChannelKindInfo[]; onClose: () => void }) {
  const [kind, setKind] = useState(channel?.kind ?? kinds[0]?.kind ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [config, setConfig] = useState<Record<string, string>>(channel?.config ?? {});
  const info = kinds.find((item) => item.kind === kind);
  const fields = info?.fields ?? [];

  const value = () => ({ kind, name: name.trim(), enabled, config: Object.fromEntries(fields.map((field) => [field.key, config[field.key] ?? ""])) });
  // Claude is never handed a secret: it asks for one it needs.
  const draft = () => {
    const current = value();
    return { ...current, config: Object.fromEntries(Object.entries(current.config).map(([key, text]) => [key, fields.find((field) => field.key === key)?.secret ? (text ? "(filled in on the form, not passed on)" : "") : text])) };
  };

  return (
    <FormDialog
      title={channel ? `Edit ${channel.name}` : "Add a channel"}
      description="Where sessions reach you: questions, permissions, ends of turns, finished tasks."
      purpose={channel ? "edit-channel" : "create-channel"}
      targetId={channel?.id}
      draft={draft}
      canSave={Boolean(kind && name.trim())}
      onSave={async () => Boolean(await attempt(() => api.saveChannel({ ...(channel ? { id: channel.id } : {}), ...value() }), "Saved."))}
      onClose={onClose}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Platform" hint={channel ? "Cannot change after creation." : undefined}>
          <Select value={kind} onValueChange={setKind} disabled={Boolean(channel)}>
            {kinds.map((item) => (
              <SelectItem key={item.kind} value={item.kind}>
                {item.label}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={info ? `My ${info.label}` : "Team Slack"} />
        </Field>
      </div>
      {fields.map((field) =>
        field.options ? (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <Select value={config[field.key] ?? ""} onValueChange={(next) => setConfig({ ...config, [field.key]: next })} placeholder={field.placeholder}>
              {field.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </Select>
          </Field>
        ) : (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <Input
              value={config[field.key] ?? ""}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              onChange={(event) => setConfig({ ...config, [field.key]: event.target.value })}
              onFocus={(event) => field.secret && event.target.value === MASK && event.target.select()}
              placeholder={field.placeholder}
              className="font-mono"
            />
          </Field>
        ),
      )}
      <Checkbox label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
    </FormDialog>
  );
}
