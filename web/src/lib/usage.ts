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

/**
 * Each account's plan usage, read from Claude Code's /usage by the hub. The
 * accounts are asked side by side and each shows as soon as it answers, so a
 * slow or signed-out one never holds the others back.
 */
export const useUsage = create<{
  readings: Record<string, UsageReading>;
  pending: Record<string, boolean>;
  load: (profileIds: string[], fresh?: boolean) => Promise<void>;
}>((set, get) => ({
  readings: {},
  pending: {},
  load: async (profileIds, fresh = false) => {
    await Promise.all(
      profileIds
        .filter((id) => !get().pending[id])
        .map(async (id) => {
          set((state) => ({ pending: { ...state.pending, [id]: true } }));
          try {
            const reading = await api.usageOf(id, fresh);
            set((state) => ({ readings: { ...state.readings, [id]: reading } }));
          } catch (error) {
            set((state) => ({ readings: { ...state.readings, [id]: { profileId: id, at: new Date().toISOString(), items: [], error: (error as Error).message } } }));
          } finally {
            set((state) => ({ pending: { ...state.pending, [id]: false } }));
          }
        }),
    );
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
