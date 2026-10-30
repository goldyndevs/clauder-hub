import { useState } from "react";
import { cn } from "../lib/cn";
import { compact } from "../lib/format";
import type { Tokens } from "../lib/types";

/**
 * The few chart forms the dashboard needs, all single-series: a number that
 * stands alone is a stat tile, a ranked list of counts is a bar list, a count
 * over days is a column strip. One hue (--series, the primary orange) for magnitude everywhere;
 * identity is always the text label beside the bar, never its color.
 */

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card px-3 py-2.5" title={hint}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function TokenTiles({ tokens }: { tokens: Tokens }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <StatTile label="Input" value={compact(tokens.input)} hint={`${tokens.input.toLocaleString()} uncached input tokens`} />
      <StatTile label="Output" value={compact(tokens.output)} hint={`${tokens.output.toLocaleString()} output tokens`} />
      <StatTile label="Cache read" value={compact(tokens.cacheRead)} hint={`${tokens.cacheRead.toLocaleString()} tokens read from the prompt cache`} />
      <StatTile label="Cache write" value={compact(tokens.cacheCreation)} hint={`${tokens.cacheCreation.toLocaleString()} tokens written to the prompt cache`} />
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Shown after the value, e.g. "2 errors". */
  note?: string;
  sublabel?: string;
}

/** Horizontal bars, longest first, label and value in text ink beside each. */
export function BarList({ rows, empty = "Nothing yet.", limit = 12, format = compact }: { rows: BarRow[]; empty?: string; limit?: number; format?: (value: number) => string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <div className="px-1 py-2 text-xs text-muted-foreground">{empty}</div>;
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const shown = all ? sorted : sorted.slice(0, limit);
  const max = Math.max(...sorted.map((row) => row.value), 1);
  return (
    <div className="space-y-1.5">
      {shown.map((row) => (
        <div key={row.key} className="group" title={`${row.label}: ${row.value.toLocaleString()}${row.note ? ` (${row.note})` : ""}`}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-mono text-[11px]">
              {row.label}
              {row.sublabel && <span className="ml-1.5 font-sans text-muted-foreground">{row.sublabel}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {format(row.value)}
              {row.note && <span className="ml-1 text-severity-critical">{row.note}</span>}
            </span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-foreground/10">
            <div className="h-1.5 rounded-full bg-series transition-all group-hover:opacity-80" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
      {sorted.length > limit && (
        <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

/** One column per day; the hovered day's value is read out above the strip. */
export function DayColumns({ days, valueOf, label }: { days: Record<string, Tokens>; valueOf: (tokens: Tokens) => number; label: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const entries = Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  if (!entries.length) return <div className="px-1 py-2 text-xs text-muted-foreground">No sessions yet.</div>;
  const max = Math.max(...entries.map(([, tokens]) => valueOf(tokens)), 1);
  const active = hover ?? entries[entries.length - 1][0];
  const activeValue = valueOf(days[active]);
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="font-medium tabular-nums">{compact(activeValue)}</span>
        <span className="text-muted-foreground">
          {label} on {active}
        </span>
      </div>
      <div className="flex h-28 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {entries.map(([day, tokens]) => {
          const value = valueOf(tokens);
          return (
            <div key={day} className="flex h-full max-w-8 flex-1 cursor-default items-end" onMouseEnter={() => setHover(day)}>
              <div
                className={cn("w-full rounded-t bg-series transition-opacity", hover && hover !== day && "opacity-50")}
                style={{ height: `${Math.max(2, (value / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{entries[0][0]}</span>
        <span>{entries[entries.length - 1][0]}</span>
      </div>
    </div>
  );
}

export function Section({ title, description, children, action, className }: { title: string; description?: string; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <section className={cn("card p-4", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
