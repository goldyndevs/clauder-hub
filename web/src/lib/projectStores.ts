import { useFileClipboard } from "./fileClipboard";
import { swapDrafts } from "./fileDrafts";
import { loadOpenFiles } from "./openFiles";

/**
 * What the page keeps per project outside the server: the open file tabs,
 * unsaved edits and a cut or copied file. Swapped when another project is shown.
 */
export function switchProjectStores(projectId: string | null): void {
  swapDrafts(projectId);
  loadOpenFiles(projectId);
  // A path cut in one project means nothing in another.
  useFileClipboard.getState().set(null);
}
