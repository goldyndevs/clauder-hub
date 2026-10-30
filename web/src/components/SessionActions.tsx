import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";
import { useConfirm } from "./Confirm";
import { Checkbox } from "./ui/Checkbox";
import { Input } from "./ui/Input";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** The confirm's body holds this checkbox; what it says is read back through the ref when the delete runs. */
function TempChoice({ temp, choice }: { temp: { path: string; bytes: number }; choice: { current: boolean } }) {
  const [checked, setChecked] = useState(choice.current);
  return (
    <div className="space-y-0.5 rounded-md border px-2.5 py-2">
      <Checkbox
        label={`Also clear its Claude temp folder (${bytes(temp.bytes)})`}
        checked={checked}
        onCheckedChange={(value) => {
          choice.current = value;
          setChecked(value);
        }}
      />
      <div className="truncate pl-6 font-mono text-[10px] text-muted-foreground" title={temp.path}>
        {temp.path}
      </div>
    </div>
  );
}

/** Rename and delete, shared by the session header and the sidebar's right-click menu. */
export function useSessionActions() {
  const confirm = useConfirm();
  const name = useRef("");
  const clearTemp = useRef(true);

  const rename = (session: Session) => {
    name.current = session.title;
    return confirm({
      title: "Rename session",
      description: "Also shown in Claude Code's /resume.",
      body: (
        <Input
          autoFocus
          size="md"
          defaultValue={session.title}
          onChange={(event) => (name.current = event.target.value)}
          onFocus={(event) => event.target.select()}
        />
      ),
      confirmLabel: "Rename",
      run: async () => {
        await api.renameSession(session.id, name.current);
        await useStore.getState().refreshSessions();
      },
    });
  };

  const remove = async (session: Session) => {
    const plan = await api.deletionPlan(session.id).catch((error: Error) => {
      useStore.getState().notify(error.message, "error");
      return null;
    });
    if (!plan) return false;
    // Checked by default each time the dialog opens.
    clearTemp.current = true;
    const deleted = await confirm({
      title: `Delete "${session.title}" permanently?`,
      description: session.live ? "It is running and will be stopped first. This cannot be undone." : "Removed from ~/.claude. This cannot be undone.",
      body: (
        <div className="space-y-2 text-xs">
          {plan.files.length ? (
            <div className="divide-y rounded-md border">
              {plan.files.map((file) => (
                <div key={file.path} className="flex items-center gap-2 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px]" title={file.path}>
                      {file.path}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{file.what}</div>
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{bytes(file.bytes)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground">No files on disk; only the hub's own record of it goes.</div>
          )}
          {plan.temp && <TempChoice temp={plan.temp} choice={clearTemp} />}
          <p className="text-[11px] text-muted-foreground">
            Also removed: its interactions and MCP suggestions in the hub. Kept: your prompt history (~/.claude/history.jsonl), which every project shares.
          </p>
        </div>
      ),
      confirmLabel: "Delete permanently",
      tone: "destructive",
      maxWidth: "max-w-xl",
      run: async () => {
        await api.deleteSession(session.id, clearTemp.current);
        await useStore.getState().refreshSessions();
        useStore.getState().notify("Deleted.");
      },
    });
    if (deleted) {
      const { view, go } = useStore.getState();
      if (view.kind === "session" && view.id === session.id) go({ kind: "page", page: "overview" });
    }
    return deleted;
  };

  return { rename, remove };
}
