import { useEffect } from "react";
import { create } from "zustand";
import { useConfirm, type ConfirmOptions } from "../components/Confirm";
import { api } from "./api";
import { useStore } from "./store";

export interface HubSettings {
  resumeOnStart: boolean;
  confirmStop: boolean;
  fullscreen: boolean;
}

/** The hub's own preferences (the global Settings page), read once for the page. */
export const useHubSettings = create<{ data: HubSettings | null; load: () => Promise<void>; save: (patch: Partial<HubSettings>) => Promise<HubSettings | null> }>((set) => ({
  data: null,
  load: async () => {
    try {
      set({ data: await api.hubSettings() });
    } catch {
      // Older hub: every default holds.
    }
  },
  save: async (patch) => {
    try {
      const data = await api.saveHubSettings(patch);
      set({ data });
      return data;
    } catch (error) {
      useStore.getState().notify((error as Error).message, "error");
      return null;
    }
  },
}));

export function useHubSettingsData(): HubSettings | null {
  const data = useHubSettings((state) => state.data);
  const load = useHubSettings((state) => state.load);
  useEffect(() => {
    if (!data) void load();
  }, [data, load]);
  return data;
}

/**
 * The confirmation for stopping sessions, unless the hub's settings turned it
 * off: then the action just runs, an error still shown.
 */
export function useStopConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const confirm = useConfirm();
  const settings = useHubSettingsData();
  return async (options) => {
    if (settings?.confirmStop !== false) return confirm(options);
    try {
      await options.run?.();
      return true;
    } catch (error) {
      useStore.getState().notify((error as Error).message, "error");
      return false;
    }
  };
}
