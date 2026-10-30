import { Eye, Pencil } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { CodeEditor } from "./CodeEditor";
import type { EditorBlame } from "./MonacoEditor";
import { Markdown } from "./Markdown";

/**
 * Every markdown document in the hub, shown rendered (View mode) with a
 * switch on a thin bar above it to the raw text in Monaco (Edit mode). The bar
 * keeps the switch off the content, which Monaco cannot pad around. Without
 * onChange the raw text is shown read-only. Front matter, which agents, skills
 * and commands start with, is shown as a key/value table above the rendered text.
 */
type Mode = "view" | "edit";

function splitFrontMatter(text: string): { fields: Array<[string, string]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: [], body: text };
  const fields: Array<[string, string]> = [];
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) fields.push([pair[1], pair[2]]);
    else if (fields.length && line.trim()) fields[fields.length - 1][1] += ` ${line.trim()}`;
  }
  return { fields, body: text.slice(match[0].length) };
}

function ModeSwitch({ mode, onChange, editable }: { mode: Mode; onChange: (mode: Mode) => void; editable: boolean }) {
  const options: Array<[Mode, typeof Eye, string]> = [
    ["view", Eye, "View mode"],
    ["edit", Pencil, editable ? "Edit mode" : "Edit mode (read-only)"],
  ];
  return (
    <div className="flex rounded-md border bg-card p-0.5">
      {options.map(([key, Icon, label]) => (
        <button
          key={key}
          title={label}
          aria-label={label}
          aria-pressed={mode === key}
          onClick={() => onChange(key)}
          className={cn("rounded p-1 transition-colors", mode === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

export function MarkdownBox({
  value,
  onChange,
  rows = 24,
  fill = false,
  blame,
  fileBlame,
  defaultMode = "view",
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  rows?: number;
  /** Takes its parent's full height instead of `rows`. */
  fill?: boolean;
  /** Git blame for Edit mode, as the code editor shows it. */
  blame?: EditorBlame;
  fileBlame?: boolean;
  /** Where it opens; View unless a box is mostly for writing. */
  defaultMode?: Mode;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const { fields, body } = splitFrontMatter(value);
  // Both modes take the same height, so switching does not make the page jump.
  const height = { height: fill ? "100%" : `${rows * 1.6 + 1}rem` };

  return (
    <div className={cn("flex flex-col overflow-hidden rounded border bg-transparent", fill && "h-full", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{mode === "view" ? "View" : onChange ? "Edit" : "Raw (read-only)"}</span>
        <ModeSwitch mode={mode} onChange={setMode} editable={Boolean(onChange)} />
      </div>
      {mode === "view" ? (
        <div className={cn("overflow-y-auto px-4 py-3", fill && "min-h-0 flex-1")} style={fill ? undefined : height}>
          {fields.length > 0 && (
            <table className="mb-3 w-full border-collapse text-[11px]">
              <tbody>
                {fields.map(([key, text]) => (
                  <tr key={key} className="border-b border-border/60">
                    <td className="w-32 py-1 pr-3 align-top font-mono text-muted-foreground">{key}</td>
                    <td className="py-1 align-top [overflow-wrap:anywhere]">{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {body.trim() ? <Markdown className="text-xs">{body}</Markdown> : <div className="text-xs text-muted-foreground">Empty.</div>}
        </div>
      ) : (
        <div className={cn(fill && "min-h-0 flex-1")} style={fill ? undefined : height}>
          <CodeEditor value={value} onChange={onChange} language="markdown" wrap blame={blame} fileBlame={fileBlame} />
        </div>
      )}
    </div>
  );
}
