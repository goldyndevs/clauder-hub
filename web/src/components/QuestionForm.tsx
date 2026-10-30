import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { Presented } from "../lib/types";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";

/** A one-line reply box: Enter sends, Shift+Enter breaks the line; no button. */
export function ReplyInput({
  placeholder,
  disabled,
  onSend,
  value,
  onChange,
  autoFocus,
  className,
}: {
  placeholder: string;
  disabled?: boolean;
  onSend: (value: string) => void;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <Textarea
      rows={1}
      autoFocus={autoFocus}
      value={value}
      disabled={disabled}
      placeholder={`${placeholder.replace(/\.\.\.$/, "")} (Enter to send)`}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (value.trim()) onSend(value);
        }
      }}
      className={cn("min-h-[32px] flex-1 font-sans", className)}
    />
  );
}

const draftKey = (id: string) => `clauder-hub:answer:${id}`;

/**
 * What was picked and typed for an interaction, kept in the browser until it
 * is answered, so a reload (F5) finds the half-made answer where it was.
 */
export function useAnswerDraft<T>(interactionId: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(draftKey(interactionId));
      return stored ? { ...initial, ...JSON.parse(stored) } : initial;
    } catch {
      return initial;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(draftKey(interactionId), JSON.stringify(next));
    } catch {
      // The draft just does not survive a reload.
    }
  };
  return [value, update];
}

export function dropAnswerDraft(interactionId: string): void {
  try {
    localStorage.removeItem(draftKey(interactionId));
  } catch {
    // Nothing was stored.
  }
}

/** The option Claude recommends: one marked so, or else the first (the hub asks Claude to put it first). */
function recommendedIndex(options: Array<{ label: string }>): number {
  const marked = options.findIndex((option) => /recommended/i.test(option.label));
  return marked === -1 ? 0 : marked;
}

type Pick = { option: number } | { other: string };

interface Draft {
  picks: Record<number, Pick>;
  otherOpen: Record<number, boolean>;
  others: Record<number, string>;
  free: string;
}

/**
 * AskUserQuestion, laid out to answer at a glance: each question numbered and
 * set off, its options as rows with the recommended one outlined in orange,
 * and an "Other" row for an answer in one's own words. One question answers on
 * the click (or Enter in Other); several are picked one by one, then sent
 * together with the button beside the free reply. Picks survive a reload.
 */
export function QuestionForm({
  interactionId,
  questions,
  busy,
  onChoose,
  onReply,
}: {
  interactionId: string;
  questions: NonNullable<Presented["questions"]>;
  busy: boolean;
  onChoose: (option: number) => void;
  onReply: (value: string) => void;
}) {
  const several = questions.length > 1;
  const [draft, setDraft] = useAnswerDraft<Draft>(interactionId, { picks: {}, otherOpen: {}, others: {}, free: "" });
  const { picks, otherOpen, others, free } = draft;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const filled = (index: number) => {
    const pick = picks[index];
    return Boolean(pick && ("option" in pick || pick.other.trim()));
  };
  // One line per question: an option number, or the words typed for it.
  const compose = () =>
    questions
      .map((_, index) => {
        const pick = picks[index];
        return "option" in pick ? String(pick.option + 1) : pick.other.trim();
      })
      .join("\n");

  return (
    <div className="space-y-3">
      {questions.map((question, index) => {
        const recommended = recommendedIndex(question.options);
        const pick = picks[index];
        return (
          <div key={index} className="space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold tabular-nums text-primary">{index + 1}</span>
              <div className="min-w-0">
                {question.header && <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{question.header}</div>}
                <div className="break-words text-sm font-semibold leading-snug">{question.question}</div>
              </div>
            </div>
            <div className="space-y-1 pl-7">
              {question.options.map((option, n) => {
                const selected = Boolean(pick && "option" in pick && pick.option === n);
                return (
                  <button
                    key={n}
                    disabled={busy}
                    onClick={() => (several ? set({ picks: { ...picks, [index]: { option: n } } }) : onChoose(n))}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md border px-3 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50",
                      n === recommended && "border-primary",
                      selected && "bg-primary/15",
                    )}
                  >
                    <span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">{n + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{option.label}</span>
                      {option.description && <span className="block text-[11px] text-muted-foreground">{option.description}</span>}
                    </span>
                  </button>
                );
              })}
              {/* An answer in one's own words, as the terminal's own "Type something" offers. */}
              {otherOpen[index] ? (
                <div className={cn("rounded-md border px-2 py-1", pick && "other" in pick && "bg-primary/15")}>
                  <ReplyInput
                    autoFocus
                    placeholder="Your own answer"
                    disabled={busy}
                    value={others[index] ?? ""}
                    onChange={(value) =>
                      set({ others: { ...others, [index]: value }, ...(several ? { picks: { ...picks, [index]: { other: value } } } : {}) })
                    }
                    onSend={(value) => (several ? set({ picks: { ...picks, [index]: { other: value } } }) : onReply(value))}
                    className="border-0 bg-transparent px-1 focus:ring-0"
                  />
                </div>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => set({ otherOpen: { ...otherOpen, [index]: true } })}
                  className="flex w-full items-center gap-2.5 rounded-md border border-dashed px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <Pencil size={12} className="shrink-0" /> Other, in your own words...
                </button>
              )}
            </div>
          </div>
        );
      })}
      {several && (
        <div className="flex items-end gap-1.5">
          <ReplyInput placeholder="Or answer all of it in your own words" disabled={busy} value={free} onChange={(value) => set({ free: value })} onSend={(value) => onReply(value)} />
          <Button variant="primary" disabled={busy || !questions.every((_, index) => filled(index))} onClick={() => onReply(compose())}>
            Send answers
          </Button>
        </div>
      )}
    </div>
  );
}

/** Clears a draft once its interaction no longer waits (answered anywhere, or closed). */
export function useForgetAnswered(interactionId: string, open: boolean): void {
  useEffect(() => {
    if (!open) dropAnswerDraft(interactionId);
  }, [interactionId, open]);
}
