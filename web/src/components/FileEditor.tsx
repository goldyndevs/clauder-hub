import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useStore } from "../lib/store";
import { useConfirm } from "./Confirm";
import { Button } from "./ui/Button";
import { MarkdownBox } from "./ui/MarkdownBox";

/** Line diff by longest common subsequence; instruction files are small enough for it. */
export function diffLines(before: string, after: string): Array<{ type: " " | "+" | "-"; line: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: Array<{ type: " " | "+" | "-"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: "-", line: a[i++] });
    else out.push({ type: "+", line: b[j++] });
  }
  while (i < a.length) out.push({ type: "-", line: a[i++] });
  while (j < b.length) out.push({ type: "+", line: b[j++] });
  return out;
}

/** Changed lines with two lines of context, the way a review shows them. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const diff = diffLines(before, after);
  return (
    <pre className="max-h-[60vh] overflow-auto rounded border font-mono text-[11px]">
      {diff
        .filter((row, index) => row.type !== " " || diff.slice(Math.max(0, index - 2), index + 3).some((near) => near.type !== " "))
        .map((row, index) => (
          <div key={index} className={cn("px-2", row.type === "+" && "bg-success/20", row.type === "-" && "bg-destructive/20")}>
            {row.type} {row.line}
          </div>
        ))}
    </pre>
  );
}

/**
 * One of Claude Code's own files: CLAUDE.md, a rule, a memory, an agent, a
 * skill or a command. Writable ones are saved in place after a diff; a
 * plugin's are shown read-only, since the plugin would overwrite them.
 */
export function FileEditor({ path, title, badge, subtitle, onSaved }: { path: string; title: string; badge?: ReactNode; subtitle?: string; onSaved?: () => void }) {
  const confirm = useConfirm();
  const [original, setOriginal] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOriginal(null);
    setError(null);
    api.memoryFile(path).then(
      (loaded) => {
        setOriginal(loaded.content);
        setText(loaded.content);
        setWritable(loaded.writable);
      },
      (cause: Error) => setError(cause.message),
    );
  }, [path]);

  if (error) return <div className="text-xs text-severity-critical">{error}</div>;
  if (original === null) return <div className="text-xs text-muted-foreground">Loading...</div>;
  const dirty = text !== original;

  const save = () =>
    confirm({
      title: `Write ${title}?`,
      description: "Writes the real file on disk.",
      body: <DiffView before={original} after={text} />,
      confirmLabel: "Write file",
      maxWidth: "max-w-3xl",
      run: async () => {
        const saved = await api.saveMemoryFile(path, text);
        setOriginal(saved.content);
        useStore.getState().notify("Written.");
        onSaved?.();
      },
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          {/* A badge such as "global" sits beside the name, never on a line of its own. */}
          <h2 className="flex items-center gap-2 font-mono text-sm font-semibold">
            <span className="min-w-0 truncate">{title}</span>
            {badge}
          </h2>
          <p className="break-all text-[11px] text-muted-foreground">
            {subtitle ?? path}
            {!writable && " · read-only (managed by a plugin)"}
            {writable && !original && " · does not exist yet; saving creates it"}
          </p>
        </div>
        {writable && (
          <div className="flex flex-wrap gap-1.5">
            {dirty && <Button onClick={() => setText(original)}>Discard</Button>}
            <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
              Review & save
            </Button>
          </div>
        )}
      </div>
      <MarkdownBox rows={26} value={text} onChange={writable ? setText : undefined} />

    </div>
  );
}
