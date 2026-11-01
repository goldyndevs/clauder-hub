import { CalendarClock, CircleHelp, Pencil, Play, Plus, RefreshCw, Square, StepForward, Trash2, Webhook, X } from "lucide-react";
import { api } from "../lib/api";
import { projectApi } from "../lib/project";
import { ago, when } from "../lib/format";
import { attempt, useLive, useStore } from "../lib/store";
import type { Job, Run } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { Section } from "./Charts";
import { useConfirm } from "./Confirm";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyId";
import { Empty } from "./ui/Empty";
import { Popover } from "./ui/Popover";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * Cron jobs and webhooks, and the one queue they feed. Creating and changing
 * them happens in a Claude session for that purpose, not in a form.
 */
export function AutomationPage() {
  const jobs = useLive(() => api.jobs(), ["jobs"]);
  const runs = useLive(() => api.runs(), ["runs"]);
  const { starting, start } = usePurpose();

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Operation</div>
            <h1 className="text-base font-semibold">Automation</h1>
            <p className="truncate text-xs text-muted-foreground" title="Cron and webhook runs, one session at a time, while the hub runs.">Cron and webhook runs, one session at a time, while the hub runs.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button disabled={starting} onClick={() => void start("queue-run")} title="Opens a Claude session to queue a run">
              <Play size={12} /> Queue a run
            </Button>
            <Button variant="primary" disabled={starting} onClick={() => void start("create-job")} title="Opens a Claude session to create a job">
              <Plus size={12} /> New job
            </Button>
          </div>
        </div>

        <Section title="Jobs">
          {jobs.data?.length ? (
            <div className="divide-y rounded-md border">
              {jobs.data.map((job) => (
                <JobRow key={job.id} job={job} onEdit={() => void start("edit-job", job.id)} />
              ))}
            </div>
          ) : (
            <Empty variant="inline" title="No jobs yet. A cron job runs a prompt on a schedule; a manual / webhook job runs when you press Run, type /job in a channel, or something calls its URL." />
          )}
        </Section>

        <Section title="Queue">
          {runs.data?.length ? <RunTable runs={runs.data} /> : <Empty variant="inline" title="Nothing has run yet." />}
        </Section>
      </div>
    </div>
  );
}

function JobRow({ job, onEdit }: { job: Job; onEdit: () => void }) {
  const confirm = useConfirm();
  const url = `${location.origin}${projectApi()}/trigger/${job.id}`;
  const curl = `curl -X POST "${url}" -H "x-clauder-token: ${job.token}" -H "content-type: application/json" -d "{\\"issue\\":\\"ABC-123\\"}"`;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        {job.kind === "cron" ? <CalendarClock size={14} className="shrink-0 text-muted-foreground" /> : <Webhook size={14} className="shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate text-xs font-medium">{job.name}</span>
        {!job.enabled && <StatusBadge tone="off">disabled</StatusBadge>}
        <StatusBadge tone="off" title={job.kind === "cron" ? "Runs on its schedule while the hub runs, and whenever it is run by hand" : "No schedule: runs when you press Run, type /job in a channel, or something calls its URL"}>
          {job.kind === "cron" ? "cron" : "manual / webhook"}
        </StatusBadge>
        <StatusBadge tone="off">{job.category || "no category"}</StatusBadge>
        <HowToRun job={job} curl={curl} />
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" title="Run now" onClick={() =>
              void confirm({
                title: `Run '${job.name}' now?`,
                description: "Joins the queue as an unattended session.",
                body: <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">{job.prompt}</pre>,
                confirmLabel: "Queue it",
                run: async () => {
                  await api.runJob(job.id);
                  useStore.getState().notify("Queued.");
                },
              })
            }>
            <Play size={13} />
          </Button>
          <Button variant="ghost" size="icon" title="Edit with Claude" onClick={onEdit}>
            <Pencil size={13} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            onClick={() =>
              void confirm({
                title: `Delete the job '${job.name}'?`,
                description: "Its schedule or webhook stops. Past runs stay.",
                confirmLabel: "Delete",
                tone: "destructive",
                run: () => api.deleteJob(job.id),
              })
            }
          >
            <Trash2 size={13} />
          </Button>
        </span>
      </div>
      <div className="mt-1 line-clamp-2 break-words pl-6 text-[11px] text-muted-foreground">{job.prompt}</div>
      <div className="mt-1 flex flex-wrap gap-3 pl-6 text-[11px] text-muted-foreground">
        {job.kind === "cron" ? (
          <>
            <span className="font-mono">{job.schedule}</span>
            <span>next: {job.nextRunAt ? when(job.nextRunAt) : "-"}</span>
          </>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="break-all font-mono">POST {projectApi()}/trigger/{job.id}</span>
            <CopyButton text={curl} />
            <span>copy curl</span>
            <Button variant="ghost" size="icon" title="New token" onClick={() =>
                void confirm({
                  title: "Issue a new token?",
                  description: "Callers using the old token stop working.",
                  confirmLabel: "Issue new token",
                  tone: "destructive",
                  run: () => api.rotateJobToken(job.id),
                })
              }>
              <RefreshCw size={11} />
            </Button>
          </span>
        )}
        <span>last run: {job.lastRunAt ? ago(job.lastRunAt) : "never"}</span>
      </div>
    </div>
  );
}

/** Every way this job can be started, so a job without a schedule is not a puzzle. */
function HowToRun({ job, curl }: { job: Job; curl: string }) {
  const local = `curl -X POST "http://127.0.0.1:${location.port || 80}${projectApi()}/jobs/${job.id}/run" -H "content-type: application/json" -d "{}"`;
  return (
    <Popover
      align="start"
      className="w-[30rem] max-w-[calc(100vw-1rem)] space-y-2.5 text-[11px]"
      trigger={
        <button className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Every way to start this job">
          <CircleHelp size={11} /> How to run
        </button>
      }
    >
      <div className="text-xs font-semibold">How to run &lsquo;{job.name}&rsquo;</div>
      {job.kind === "cron" ? (
        <HowStep title="On its schedule">
          <span className="font-mono">{job.schedule}</span>, next {job.nextRunAt ? when(job.nextRunAt) : "-"}, while the hub runs{job.enabled ? "" : " (disabled now)"}.
        </HowStep>
      ) : (
        <HowStep title="No schedule">It runs only when started one of the ways below.</HowStep>
      )}
      <HowStep title="From this page">
        Press <Play size={11} className="inline" /> Run. It asks first, then joins the project&rsquo;s queue (one run at a time). In the queue below, <Square size={10} className="inline" /> stops a running run and <StepForward size={10} className="inline" /> resumes a stopped one where it left off.
      </HowStep>
      <HowStep title="From a channel">
        <span className="font-mono">/job {job.name}</span> on Telegram (<span className="font-mono">!job</span> on Slack), or <span className="font-mono">/jobs</span> and pick it. It asks before it queues. <span className="font-mono">/stop</span> stops it, <span className="font-mono">/resume</span> carries it on.
      </HowStep>
      {job.kind === "webhook" && (
        <HowStep title="From another tool (webhook)">
          <span className="flex items-center gap-1">
            <span className="min-w-0 break-all font-mono">POST {projectApi()}/trigger/{job.id}</span>
            <CopyButton text={curl} />
          </span>
          With the header <span className="font-mono">x-clauder-token</span> (the job&rsquo;s token, in the copied curl; renew it with <RefreshCw size={10} className="inline" /> on the row). The JSON body reaches the prompt as <span className="font-mono">{"{{payload}}"}</span> or <span className="font-mono">{"{{payload.field}}"}</span>.
        </HowStep>
      )}
      <HowStep title="From an app on this machine">
        <span className="flex items-center gap-1">
          <span className="min-w-0 break-all font-mono">POST {projectApi()}/jobs/{job.id}/run</span>
          <CopyButton text={local} />
        </span>
        No token: the hub only listens on 127.0.0.1. An optional <span className="font-mono">{"{\"payload\": {...}}"}</span> body fills the prompt as above.
      </HowStep>
    </Popover>
  );
}

function HowStep({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-medium text-foreground">{title}</div>
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}

const RUN_TONE: Record<Run["status"], "on" | "off" | "success" | "warning" | "critical"> = {
  queued: "off",
  running: "warning",
  done: "success",
  exited: "off",
  cancelled: "off",
};

function RunTable({ runs }: { runs: Run[] }) {
  const go = useStore((state) => state.go);
  const confirm = useConfirm();
  const label = (run: Run) => run.jobName ?? run.prompt.slice(0, 60);
  return (
    <div className="divide-y rounded-md border">
      {runs.map((run) => (
        <div key={run.id} className="flex items-center gap-2 px-3 py-2 text-xs">
          <StatusBadge tone={RUN_TONE[run.status]}>{run.status}</StatusBadge>
          {run.resume && <StatusBadge tone="off" title="Queued again to carry on its own session">resumed</StatusBadge>}
          <span className="hidden w-16 shrink-0 text-[11px] text-muted-foreground sm:block">{run.source}</span>
          <span className="min-w-0 flex-1 truncate">
            {run.jobName && <span className="font-medium">{run.jobName}: </span>}
            <span className="text-muted-foreground">{run.prompt}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{ago(run.createdAt)}</span>
          {run.sessionId && (
            <Button variant="ghost" size="sm" onClick={() => go({ kind: "session", id: run.sessionId! })}>
              Open
            </Button>
          )}
          {run.status === "running" && run.sessionId && (
            <Button variant="ghost" size="icon" title="Stop" onClick={() =>
                void confirm({
                  title: `Stop '${label(run)}'?`,
                  description: "Its terminal closes and the queue moves on. The conversation is kept: Resume carries on from where it stopped.",
                  confirmLabel: "Stop",
                  tone: "destructive",
                  run: () => api.stopRun(run.id),
                })
              }>
              <Square size={13} />
            </Button>
          )}
          {run.status === "exited" && run.sessionId && (
            <Button variant="ghost" size="icon" title="Resume" onClick={() =>
                void confirm({
                  title: `Resume '${label(run)}'?`,
                  description: "Joins the back of the queue as an unattended run and carries on its own conversation from where it stopped.",
                  confirmLabel: "Queue it",
                  run: async () => {
                    const { position } = await api.resumeRun(run.id);
                    useStore.getState().notify(`Queued, number ${position} in line.`);
                  },
                })
              }>
              <StepForward size={13} />
            </Button>
          )}
          {run.status === "queued" && (
            <Button variant="ghost" size="icon" title="Cancel" onClick={() => void attempt(() => api.cancelRun(run.id))}>
              <X size={13} />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
