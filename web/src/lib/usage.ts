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

/** The limits worth a bar: the session and the week across all models; per-model weeks and credits are left out. */
export function mainLimits(items: UsageItem[]): UsageItem[] {
  return items.filter((item) => /^current session/i.test(item.label) || /^current week\s*(\(all models\))?\s*$/i.test(item.label));
}

const HIDDEN_KEY = "clauder-hub:usage-hidden";

function readHidden(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The accounts whose usage this browser does not show, nor have read. */
export const useUsageHidden = create<{ ids: string[]; toggle: (id: string) => void }>((set, get) => ({
  ids: readHidden(),
  toggle: (id) => {
    const ids = get().ids.includes(id) ? get().ids.filter((item) => item !== id) : [...get().ids, id];
    set({ ids });
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
    } catch {
      // The choice just does not persist.
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
