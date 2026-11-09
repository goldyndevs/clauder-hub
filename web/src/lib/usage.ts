import { create } from "zustand";
import { api } from "./api";

export interface UsageItem {
  label: string;
  percent: number;
  detail: string;
}

export interface UsageReading {
  profileId: string;
  at: string;
  items: UsageItem[];
  error: string | null;
}

/** Each account's plan usage, read from Claude Code's /usage by the hub; a few seconds per account. */
export const useUsage = create<{ data: UsageReading[] | null; loading: boolean; load: (fresh?: boolean) => Promise<void> }>((set, get) => ({
  data: null,
  loading: false,
  load: async (fresh = false) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      set({ data: await api.usage(fresh) });
    } catch {
      // An older hub, or Claude Code not there: the bars just do not show.
    } finally {
      set({ loading: false });
    }
  },
}));

/** "Current week (all models)" as a bar's short label: "Week". */
export function shortLabel(label: string): string {
  if (/^current session/i.test(label)) return "Session";
  const week = /^current week\s*\(([^)]+)\)/i.exec(label);
  if (week) return /all models/i.test(week[1]) ? "Week" : `Week ${week[1]}`;
  if (/^current week/i.test(label)) return "Week";
  if (/credits/i.test(label)) return "Credits";
  return label;
}
