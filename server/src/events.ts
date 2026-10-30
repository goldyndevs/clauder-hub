import { maybeProject } from "./context.js";

/**
 * One live feed for the whole dashboard. Events say what changed, not the new
 * state: the page refetches the part it shows, so there is one way to read
 * everything and nothing to keep in step.
 */
export type Topic =
  | "sessions" // the list, a status, a terminal coming or going
  | "transcript" // a session's transcript grew; payload { sessionId }
  | "interactions"
  | "runs"
  | "jobs"
  | "mcp"
  | "channels"
  | "files" // the project's files moved through the Files tab; payload { paths }
  | "projects"; // the hub's project list

export interface HubEvent {
  topic: Topic;
  /** The project it happened in; absent for the hub's own topics. The page drops other projects' events. */
  project?: string;
  payload: Record<string, unknown>;
  ts: string;
}

type Listener = (event: HubEvent) => void;
const listeners = new Set<Listener>();

export function broadcast(topic: Topic, payload: Record<string, unknown> = {}): void {
  const event: HubEvent = { topic, project: maybeProject()?.id, payload, ts: new Date().toISOString() };
  for (const listener of listeners) listener(event);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
