import { create } from "zustand";

/** What Cut or Copy put aside for Paste. A cut entry shows faded until it is pasted, as in VS Code. */
export const useFileClipboard = create<{ item: { mode: "cut" | "copy"; path: string } | null; set: (item: { mode: "cut" | "copy"; path: string } | null) => void }>((set) => ({
  item: null,
  set: (item) => set({ item }),
}));
