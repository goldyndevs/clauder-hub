/** What every channel calls each kind of interaction, and the one way they shorten text. */
export const KIND_LABEL: Record<string, string> = {
  permission: "Permission",
  question: "Question",
  turn: "Waiting for you",
  mcp: "MCP suggested",
  done: "Done",
};

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
