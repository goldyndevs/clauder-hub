import { DiffEditor } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
// Importing it sets up Monaco itself: the bundled copy, its workers, the hub's theme.
import { languageOf } from "./MonacoEditor";

export interface CodeDiffProps {
  /** As HEAD has it, on the left; never edited. */
  original: string;
  /** What is in the editor now, on the right. */
  modified: string;
  path: string;
  /** Without it the right side is read-only too. */
  onChange?: (value: string) => void;
}

/** Monaco's side by side diff, as VS Code shows a changed file: HEAD on the left, the file on the right. */
export default function MonacoDiff({ original, modified, path, onChange }: CodeDiffProps) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const subscription = useRef<monaco.IDisposable | null>(null);
  useEffect(() => () => subscription.current?.dispose(), []);

  return (
    <DiffEditor
      height="100%"
      theme="clauder-dark"
      original={original}
      modified={modified}
      language={languageOf(path)}
      loading={null}
      onMount={(editor) => {
        const right = editor.getModifiedEditor();
        subscription.current?.dispose();
        subscription.current = right.onDidChangeModelContent(() => changeRef.current?.(right.getValue()));
      }}
      options={{
        readOnly: !onChange,
        originalEditable: false,
        renderSideBySide: true,
        // Side by side even in a narrow pane, as asked: the two versions are the point.
        useInlineViewWhenSpaceIsLimited: false,
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderOverviewRuler: true,
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
