/// <reference types="vite/client" />
import Editor, { loader } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { registerFormatters } from "./monacoFormatters";

/**
 * Monaco, bundled with the page rather than fetched from a CDN, and loaded
 * only through CodeEditor's lazy import so the dashboard's first load does
 * not carry it. Its language workers are Vite worker chunks of their own.
 */
self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
registerFormatters(monaco);

// The dark palette of index.css: the card surface, its border and muted tones, the primary orange.
monaco.editor.defineTheme("clauder-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1d1d1b",
    "editor.foreground": "#faf9f5",
    "editorCursor.foreground": "#d97757",
    "editor.selectionBackground": "#d9775755",
    "editor.inactiveSelectionBackground": "#d9775730",
    "editor.lineHighlightBackground": "#2a2a28",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#6b6a64",
    "editorLineNumber.activeForeground": "#a09e92",
    "editorWidget.background": "#1d1d1b",
    "editorWidget.border": "#353531",
    "editorIndentGuide.background1": "#2a2a28",
    "focusBorder": "#d9775780",
    "scrollbarSlider.background": "#35353199",
    "scrollbarSlider.hoverBackground": "#353531",
  },
});

/** The Monaco language for a file name, from what Monaco itself registers. */
function languageOf(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const match = monaco.languages
    .getLanguages()
    .find((language) => language.filenames?.some((file) => file.toLowerCase() === name) || (extension && language.extensions?.includes(extension)));
  return match?.id ?? "plaintext";
}

/** What the editor needs of a file's git blame; given only while the text matches what was blamed. */
export interface EditorBlame {
  you: string;
  commits: Record<string, { sha: string; author: string; email: string; time: number; summary: string; uncommitted: boolean }>;
  /** The commit of each line, by line number minus one. */
  lines: string[];
  /** Fetches a commit's full message for the hover. */
  details?: (sha: string) => Promise<string>;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** A file path to take the language from, unless `language` names it. */
  path?: string;
  language?: string;
  /** Long lines wrap: prose rather than code. */
  wrap?: boolean;
  /** GitLens-like annotations: the cursor line's last change, and with fileBlame every line's. */
  blame?: EditorBlame;
  fileBlame?: boolean;
}

function relative(seconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  const units: Array<[number, string]> = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    const count = Math.floor(diff / size);
    if (count >= 1) return `${count} ${unit}${count > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

type Commit = EditorBlame["commits"][string];
const who = (commit: Commit, you: string) => (commit.uncommitted || (you && commit.author === you) ? "You" : commit.author);

/** The cursor line's annotation, as GitLens writes it. */
function inlineText(commit: Commit, you: string): string {
  if (commit.uncommitted) return "You • Uncommitted changes";
  return `${who(commit, you)}, ${relative(commit.time)} • ${commit.summary}`;
}

function hoverText(commit: Commit, you: string, message?: string): string {
  if (commit.uncommitted) return "**You** · Uncommitted changes";
  const date = new Date(commit.time * 1000).toLocaleString();
  return [`**${who(commit, you)}**${commit.email ? ` <${commit.email}>` : ""}, ${relative(commit.time)} (${date})`, "", message ?? commit.summary, "", `\`${commit.sha.slice(0, 8)}\``].join("\n");
}

/** The file-blame column: fixed width, so the code stays aligned in a monospace font. */
const GUTTER_WIDTH = 28;
function gutterText(commit: Commit, you: string): string {
  const age = commit.uncommitted ? "" : relative(commit.time).replace(/ ago$/, "");
  const name = who(commit, you);
  const room = GUTTER_WIDTH - age.length - 2;
  return `${(name.length > room ? `${name.slice(0, room - 1)}…` : name).padEnd(room)} ${age} │ `.padEnd(GUTTER_WIDTH + 3);
}

export default function MonacoEditor({ value, onChange, path, language, wrap = false, blame, fileBlame = false }: CodeEditorProps) {
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const messages = useRef(new Map<string, string>());
  const blameRef = useRef(blame);
  blameRef.current = blame;

  // The cursor line's annotation follows the cursor; the hover gets the full message once fetched.
  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection();
    const paint = () => {
      const current = blameRef.current;
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!current || !model || !position) return collection.clear();
      const commit = current.commits[current.lines[position.lineNumber - 1]];
      if (!commit) return collection.clear();
      const end = model.getLineMaxColumn(position.lineNumber);
      collection.set([
        {
          range: new monaco.Range(position.lineNumber, end, position.lineNumber, end),
          options: {
            after: { content: `      ${inlineText(commit, current.you)}`, inlineClassName: "clauder-blame-inline" },
            hoverMessage: { value: hoverText(commit, current.you, messages.current.get(commit.sha)) },
          },
        },
      ]);
      if (!commit.uncommitted && !messages.current.has(commit.sha) && current.details) {
        void current.details(commit.sha).then((message) => {
          messages.current.set(commit.sha, message);
          paint();
        }, () => undefined);
      }
    };
    paint();
    const cursor = editor.onDidChangeCursorPosition(paint);
    const content = editor.onDidChangeModelContent(paint);
    return () => {
      cursor.dispose();
      content.dispose();
      collection.clear();
    };
  }, [editor, blame]);

  // The whole-file column: each block of lines from one commit is labelled once.
  useEffect(() => {
    if (!editor || !blame || !fileBlame) return;
    const collection = editor.createDecorationsCollection(
      blame.lines.map((sha, index) => {
        const commit = blame.commits[sha];
        const first = index === 0 || blame.lines[index - 1] !== sha;
        return {
          range: new monaco.Range(index + 1, 1, index + 1, 1),
          options: {
            before: {
              content: first && commit ? gutterText(commit, blame.you) : `${" ".repeat(GUTTER_WIDTH - 1)}│ `.padEnd(GUTTER_WIDTH + 3),
              inlineClassName: "clauder-blame-gutter",
            },
            hoverMessage: first && commit ? { value: hoverText(commit, blame.you, messages.current.get(sha)) } : undefined,
          },
        };
      }),
    );
    return () => collection.clear();
  }, [editor, blame, fileBlame]);

  return (
    <Editor
      height="100%"
      theme="clauder-dark"
      value={value}
      language={language ?? (path ? languageOf(path) : "plaintext")}
      onChange={(next) => onChange?.(next ?? "")}
      onMount={(instance) => setEditor(instance)}
      loading={null}
      options={{
        readOnly: !onChange,
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: wrap ? "on" : "off",
        padding: { top: 8, bottom: 8 },
        renderLineHighlight: "line",
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}
