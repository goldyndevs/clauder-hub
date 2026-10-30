import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ClaudeStatus } from "../lib/types";
import { Button } from "./ui/Button";

/**
 * Everything here runs on Claude Code, so a machine without it (or signed
 * out of it) is said at the top of every page, with the one command that
 * fixes it. Looked at again every half minute while something is wrong, so
 * the banner goes away on its own once it is fixed; no restart needed.
 */
export function ClaudeBanner() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .hub()
      .then((hub) => alive && setStatus(hub.claudeStatus))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api.checkClaude());
    } catch {
      // The banner stays as it was.
    } finally {
      setChecking(false);
    }
  };

  // The first answer can come before the hub's own check finished; while something is wrong, keep looking.
  const problem = status?.problem ?? null;
  const unknown = status === null;
  useEffect(() => {
    if (!problem && !unknown) return;
    const timer = setInterval(() => void (problem ? check() : api.hub().then((hub) => setStatus(hub.claudeStatus)).catch(() => undefined)), problem ? 30_000 : 5_000);
    return () => clearInterval(timer);
  }, [problem, unknown]);

  if (!status?.problem) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(status.fix ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-destructive/15 px-5 py-2 text-xs">
      <AlertTriangle size={14} className="shrink-0 text-destructive" />
      <span className="min-w-0">
        <b>{status.message}</b> Sessions, runs and chat commands cannot start until then.
      </span>
      {status.fix && (
        <span className="flex items-center gap-1">
          Run
          <code className="rounded bg-background px-1.5 py-0.5 font-mono">{status.fix}</code>
          <Button variant="ghost" size="icon" onClick={copy} title={copied ? "Copied" : "Copy"} aria-label="Copy the command">
            <Copy size={12} />
          </Button>
          {status.problem === "missing" ? "in a terminal, then sign in with" : "in a terminal on this machine."}
          {status.problem === "missing" && <code className="rounded bg-background px-1.5 py-0.5 font-mono">claude auth login</code>}
        </span>
      )}
      <Button variant="muted" onClick={() => void check()} disabled={checking} className="ml-auto">
        <RefreshCw size={12} className={checking ? "animate-spin" : undefined} />
        {checking ? "Checking..." : "Check again"}
      </Button>
    </div>
  );
}
