import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./MonacoEditor";

// Monaco is megabytes: it is fetched the first time an editor is shown, never with the dashboard.
const MonacoEditor = lazy(() => import("./MonacoEditor"));

/** Monaco in the hub's theme, filling its parent's height. Without onChange it is read-only. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="px-3 py-2 text-xs text-muted-foreground">Loading editor...</div>}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}
