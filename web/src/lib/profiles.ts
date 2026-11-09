import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api";
import type { ProfilesInfo } from "./types";

/**
 * The Claude accounts sessions can run under, read once for the whole page
 * and read again after a change (they are the hub's, not a project's).
 */
export const useProfiles = create<{ data: ProfilesInfo | null; load: (fresh?: boolean) => Promise<void> }>((set) => ({
  data: null,
  load: async (fresh = false) => {
    try {
      set({ data: await api.profiles(fresh) });
    } catch {
      // The hub is restarting or older: the account choices just do not show.
    }
  },
}));

export function useProfileList(): ProfilesInfo | null {
  const data = useProfiles((state) => state.data);
  const load = useProfiles((state) => state.load);
  useEffect(() => {
    if (!data) void load();
  }, [data, load]);
  return data;
}

/** An account's name, for a badge; null when there is only the default one, so nothing needs saying. */
export function profileLabel(info: ProfilesInfo | null, id: string | null | undefined): string | null {
  if (!info || info.profiles.length < 2 || !id) return null;
  return info.profiles.find((profile) => profile.id === id)?.name ?? id;
}
