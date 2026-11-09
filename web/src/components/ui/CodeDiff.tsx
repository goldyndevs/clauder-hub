import { lazy, Suspense } from "react";
import type { CodeDiffProps } from "./MonacoDiff";

// Monaco comes with its own chunk, the first time a diff or an editor is shown.
const MonacoDiff = lazy(() => import("./MonacoDiff"));

/** A side by side diff in the hub's theme, filling its parent's height. */
export function CodeDiff(props: CodeDiffProps) {
  return (
    <Suspense fallback={<div className="px-3 py-2 text-xs text-muted-foreground">Loading diff...</div>}>
      <MonacoDiff {...props} />
    </Suspense>
  );
}
