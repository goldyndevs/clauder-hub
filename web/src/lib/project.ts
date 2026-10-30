/**
 * The project the page is showing, from the route (#/<project id>/...). Every
 * project call goes to /api/p/<project id>; the hub's own (its project list,
 * the live feed) stay at /api. Kept apart from the store so the API modules
 * can read it without importing the store.
 */
let current: string | null = null;

/** The hub's own context (#/global): every project at once; the server serves it at /api/p/global. */
export const GLOBAL_ID = "global";

export function setCurrentProject(id: string | null): void {
  current = id;
}

export function currentProjectId(): string | null {
  return current;
}

/** The project's API root; calling it without a project open is a bug in the page. */
export function projectApi(): string {
  if (!current) throw new Error("No project is open.");
  return `/api/p/${encodeURIComponent(current)}`;
}
