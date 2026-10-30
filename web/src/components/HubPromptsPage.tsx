import { MessageSquareText, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useLive, useStore } from "../lib/store";
import type { Category, PromptDefinition } from "../lib/types";
import { useConfirm } from "./Confirm";
import { DiffView } from "./FileEditor";
import { CategorySelect } from "./CategorySelect";
import { BackToList, PageHeader } from "./Page";
import { Button } from "./ui/Button";
import { Empty } from "./ui/Empty";
import { StatusBadge } from "./ui/StatusBadge";
import { MarkdownBox } from "./ui/MarkdownBox";

const AUDIENCE: Record<PromptDefinition["audience"], string> = {
  "claude-system": "Appended to Claude's system prompt",
  "claude-typed": "Typed into the session",
  channel: "Sent to channels",
};

/**
 * Every word the hub itself puts in front of Claude or a person. Stored in the
 * hub's database, so editing one touches no file, and each can go back to its
 * default. Claude Code's own instruction files are under Project.
 */
export function HubPromptsPage() {
  const prompts = useLive(() => api.prompts(), []);
  const [selected, setSelected] = useState<string>("preview");
  // Below md the list and the editor take turns.
  const [showDetail, setShowDetail] = useState(false);
  const choose = (key: string) => {
    setSelected(key);
    setShowDetail(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-5 py-4">
        <PageHeader
          group="Settings"
          title="Hub prompts"
          description="Text the hub adds to sessions and sends to channels."
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("w-full shrink-0 overflow-y-auto p-3 md:block md:w-56 md:border-r lg:w-72", showDetail && "hidden")}>
          <ListItem active={selected === "preview"} onClick={() => choose("preview")}>
            Preview what a session gets
          </ListItem>
          {(["claude-system", "claude-typed", "channel"] as const).map((audience) => (
            <div key={audience} className="mt-3">
              <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{AUDIENCE[audience]}</div>
              {(prompts.data ?? [])
                .filter((item) => item.audience === audience)
                .map((item) => (
                  <ListItem key={item.key} active={selected === item.key} onClick={() => choose(item.key)}>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.overridden && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Edited" />}
                  </ListItem>
                ))}
            </div>
          ))}
        </div>
        <div className={cn("min-w-0 flex-1 overflow-y-auto p-4 md:block md:p-5", !showDetail && "hidden")}>
          <BackToList onClick={() => setShowDetail(false)} />
          {selected === "preview" ? (
            <Preview />
          ) : (
            prompts.data && <PromptEditor key={selected} prompt={prompts.data.find((item) => item.key === selected)!} onSaved={prompts.reload} />
          )}
        </div>
      </div>
    </div>
  );
}

function ListItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
    >
      <MessageSquareText size={12} className="shrink-0" />
      {children}
    </button>
  );
}

function PromptEditor({ prompt, onSaved }: { prompt: PromptDefinition; onSaved: () => void }) {
  const confirm = useConfirm();
  const [text, setText] = useState(prompt.text);
  const dirty = text !== prompt.text;

  const save = () =>
    confirm({
      title: `Save "${prompt.label}"?`,
      description: "New sessions get the new text.",
      body: <DiffView before={prompt.text} after={text} />,
      confirmLabel: "Save",
      maxWidth: "max-w-3xl",
      run: async () => {
        await api.savePrompt(prompt.key, text);
        useStore.getState().notify("Saved.");
        onSaved();
      },
    });

  const restore = () =>
    confirm({
      title: "Restore the default text?",
      description: "Your version is discarded.",
      body: <DiffView before={prompt.text} after={prompt.defaultText} />,
      confirmLabel: "Restore default",
      tone: "destructive",
      maxWidth: "max-w-3xl",
      run: async () => {
        await api.savePrompt(prompt.key, null);
        setText(prompt.defaultText);
        onSaved();
      },
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {prompt.label}
            {prompt.overridden && <StatusBadge tone="on">edited</StatusBadge>}
          </h2>
          <p className="text-[11px] text-muted-foreground">{prompt.description}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {prompt.overridden && (
            <Button variant="ghost" onClick={() => void restore()}>
              <RotateCcw size={12} /> Restore default
            </Button>
          )}
          {dirty && <Button onClick={() => setText(prompt.text)}>Discard</Button>}
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            Review & save
          </Button>
        </div>
      </div>
      {prompt.placeholders.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Placeholders:{" "}
          {prompt.placeholders.map((name) => (
            <code key={name} className="mr-1 rounded bg-muted px-1 font-mono">{`{{${name}}}`}</code>
          ))}
        </div>
      )}
      <MarkdownBox rows={22} value={text} onChange={setText} />
    </div>
  );
}

function Preview() {
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const preview = useLive(() => api.previewSystemPrompt(category), [], category);
  useEffect(() => {
    void api.categories().then(setCategories);
  }, []);
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">What the hub appends to a session</h2>
        <p className="text-[11px] text-muted-foreground">
          Passed with --append-system-prompt-file, after Claude Code's own system prompt and your CLAUDE.md files, which still load as usual. Pick a category to see the done protocol a
          triggered run gets.
        </p>
      </div>
      <div className="w-full max-w-[18rem]">
        <CategorySelect value={category} onChange={setCategory} categories={categories} />
      </div>
      {preview.data ? <MarkdownBox rows={24} value={preview.data.text} /> : <Empty variant="inline" title="Loading..." />}
    </div>
  );
}
