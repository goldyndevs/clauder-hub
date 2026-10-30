import { CheckCircle2, ChevronRight, HelpCircle, MessageSquare, Plug, ShieldQuestion, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { attempt, useStore } from "../lib/store";
import type { Choice, Interaction, Presented } from "../lib/types";
import { Button } from "./ui/Button";
import { Markdown } from "./ui/Markdown";
import { StatusBadge } from "./ui/StatusBadge";
import { QuestionForm, ReplyInput, useForgetAnswered } from "./QuestionForm";

const KIND = {
  permission: { label: "Permission", icon: ShieldQuestion },
  question: { label: "Question", icon: HelpCircle },
  turn: { label: "Waiting", icon: MessageSquare },
  mcp: { label: "MCP suggested", icon: Plug },
  done: { label: "Done", icon: CheckCircle2 },
} as const;

/** What an answer meant, in the words of the button that gave it. */
function answerLabel(interaction: Interaction): string | null {
  const answer = interaction.answer;
  if (!answer) return null;
  const presented = interaction.presented;
  const byKey: Record<string, Record<string, number>> = { permission: { "1": 0, "2": 1, "3": 2 }, mcp: { install: 0, skip: 1 } };
  const index = interaction.kind === "question" ? Number(answer) - 1 : byKey[interaction.kind]?.[answer];
  return (index !== undefined && Number.isInteger(index) && presented?.choices[index]?.label) || answer;
}

/**
 * One thing a session is waiting on, laid out the way Claude Code's own
 * question tool is: a one-line headline, the choices as buttons, a typed
 * answer when a choice will not do, and the raw text folded away. It draws
 * from the same presented shape the channels do, and the answer is typed into
 * the session's terminal for it.
 */
export function InteractionCard({
  interaction,
  showSession = false,
  compact = false,
  project,
}: {
  interaction: Interaction;
  showSession?: boolean;
  compact?: boolean;
  /** Set on #/global: the project it is in, which answers it and whose terminal it opens. */
  project?: { id: string; name: string };
}) {
  const sessions = useStore((state) => state.sessions);
  const goHere = useStore((state) => state.go);
  const go = (view: { kind: "session"; id: string }) => (project ? (window.location.hash = `#/${encodeURIComponent(project.id)}/session/${view.id}`) : goHere(view));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const kind = KIND[interaction.kind];
  const open = interaction.status === "open";
  const session = sessions.find((item) => item.id === interaction.sessionId);
  useForgetAnswered(interaction.id, open);
  const presented: Presented = interaction.presented ?? {
    kind: interaction.kind,
    sessionTitle: session?.title ?? "",
    headline: interaction.title,
    choices: [],
    quickReplies: [],
    freeText: "Reply to the session...",
    details: interaction.body ? { label: "Details", text: interaction.body, format: "markdown" } : undefined,
    answerable: open,
  };

  const run = async (send: () => Promise<unknown>) => {
    setBusy(true);
    const result = await attempt(send, "Sent to the session.");
    setBusy(false);
    if (result) setText("");
  };
  const choose = (choice: Choice) => run(() => (project ? api.chooseIn(project.id, interaction.id, choice.ref) : api.choose(interaction.id, choice.ref)));
  const reply = (value: string) => value.trim() && run(() => (project ? api.answerIn(project.id, interaction.id, value) : api.answer(interaction.id, value)));

  return (
    <div className={cn("card p-3", open && "border-primary/60")}>
      <div className="flex items-center gap-2">
        <StatusBadge tone={open ? "warning" : interaction.kind === "done" ? "success" : "off"} icon={kind.icon}>
          {kind.label}
        </StatusBadge>
        {project && <StatusBadge tone="off">{project.name}</StatusBadge>}
        {showSession && (
          <button className="min-w-0 truncate text-xs font-medium hover:underline" onClick={() => go({ kind: "session", id: interaction.sessionId })}>
            {session?.title ?? (interaction.presented?.sessionTitle || interaction.sessionId.slice(0, 8))}
          </button>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{ago(interaction.createdAt)}</span>
        {/* Away from the session (the inbox), one click to its terminal, which is the tab a session opens on. */}
        {showSession && (
          <Button
            variant="muted"
            className="shrink-0"
            title={session?.live ? "Open the session's terminal" : "Open the session (not running; resume it there)"}
            aria-label="Open the session's terminal"
            onClick={() => go({ kind: "session", id: interaction.sessionId })}
          >
            <SquareTerminal size={12} /> <span className="hidden sm:inline">Terminal</span>
          </Button>
        )}
      </div>

      <div className={cn("mt-2 break-words text-sm font-medium", interaction.kind === "permission" && "font-mono text-[13px]", compact && "line-clamp-2")}>{presented.headline}</div>
      {presented.question && !compact && <div className="mt-0.5 break-words text-xs text-muted-foreground">{presented.question}</div>}

      {open && !compact && (
        <div className="mt-3 space-y-2.5">
          {interaction.kind === "question" && presented.questions?.length ? (
            <QuestionForm
              interactionId={interaction.id}
              questions={presented.questions}
              busy={busy}
              onChoose={(index) => void choose({ ref: `o:${index}`, label: "" })}
              onReply={(value) => void reply(value)}
            />
          ) : (
            <>
              {presented.choices.some((choice) => choice.description) ? (
                // Options that explain themselves read as a list, the way the question tool shows them.
                <div className="space-y-1">
                  {presented.choices.map((choice, index) => (
                    <button
                      key={choice.ref}
                      disabled={busy}
                      onClick={() => void choose(choice)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50",
                        choice.tone === "primary" && "border-primary",
                      )}
                    >
                      <span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">{choice.label}</span>
                        {choice.description && <span className="block text-[11px] text-muted-foreground">{choice.description}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                presented.choices.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {presented.choices.map((choice) => (
                      <Button
                        key={choice.ref}
                        variant={choice.tone === "primary" ? "primary" : choice.tone === "danger" ? "destructive" : "muted"}
                        disabled={busy}
                        onClick={() => void choose(choice)}
                      >
                        {choice.label}
                      </Button>
                    ))}
                  </div>
                )
              )}

              {presented.quickReplies.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {presented.quickReplies.map((choice) => (
                    <button
                      key={choice.ref}
                      disabled={busy}
                      onClick={() => void choose(choice)}
                      className="rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              )}

              {presented.freeText && <ReplyInput placeholder={presented.freeText} disabled={busy} value={text} onChange={setText} onSend={(value) => void reply(value)} />}
            </>
          )}
        </div>
      )}

      {presented.details && !compact && (
        <div className="mt-2">
          <button className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowDetails(!showDetails)}>
            <ChevronRight size={12} className={cn("transition-transform", showDetails && "rotate-90")} />
            {presented.details.label}
          </button>
          {showDetails &&
            (presented.details.format === "code" ? (
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">{presented.details.text}</pre>
            ) : (
              <Markdown className="mt-1.5 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs">{presented.details.text}</Markdown>
            ))}
        </div>
      )}

      {!open && interaction.status === "answered" && (
        <div className="mt-2 break-words text-[11px] text-muted-foreground">
          {interaction.answeredBy}: <span className="text-foreground">{answerLabel(interaction)}</span>
        </div>
      )}
      {!open && interaction.status === "closed" && interaction.answeredBy && interaction.kind !== "done" && (
        <div className="mt-2 text-[11px] text-muted-foreground">Closed ({interaction.answeredBy}).</div>
      )}
    </div>
  );
}
