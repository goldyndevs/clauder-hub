import { nanoid } from "nanoid";
import { db, now, parseJson } from "./db.js";

/**
 * A task category says what "done" means: the deliverables a session must
 * report before the hub closes it. They are the user's own, any number of them.
 */
export interface Deliverable {
  name: string;
  description: string;
  required: boolean;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  deliverables: Deliverable[];
}

interface Row {
  id: string;
  name: string;
  description: string;
  deliverables: string;
}

const toCategory = (row: Row): Category => ({
  id: row.id,
  name: row.name,
  description: row.description,
  deliverables: parseJson<Deliverable[]>(row.deliverables, []),
});

export function listCategories(): Category[] {
  return (db.prepare("SELECT * FROM categories ORDER BY name COLLATE NOCASE").all() as Row[]).map(toCategory);
}

export function findCategory(name: string): Category | null {
  const row = db.prepare("SELECT * FROM categories WHERE name = ? COLLATE NOCASE").get(name.trim()) as Row | undefined;
  return row ? toCategory(row) : null;
}

export function saveCategory(input: { id?: string; name: string; description?: string; deliverables?: Deliverable[] }): Category {
  const name = input.name.trim();
  if (!name || name.toLowerCase() === "auto") throw new Error("A category needs a name, and 'auto' is reserved.");
  const deliverables = (input.deliverables ?? [])
    .map((item) => ({ name: item.name.trim(), description: (item.description ?? "").trim(), required: item.required !== false }))
    .filter((item) => item.name);
  const id = input.id ?? nanoid(10);
  db.prepare(
    `INSERT INTO categories (id, name, description, deliverables, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, deliverables = excluded.deliverables, updated_at = excluded.updated_at`,
  ).run(id, name, input.description?.trim() ?? "", JSON.stringify(deliverables), now(), now());
  return toCategory(db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as Row);
}

export function deleteCategory(id: string): void {
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
}

/** The list as the done protocol shows it to Claude. */
export function describeCategories(): string {
  const categories = listCategories();
  if (!categories.length) return "(No categories are defined. Use \"general\" and report whatever evidence shows the task is complete.)";
  return categories
    .map((category) => {
      const lines = category.deliverables.map(
        (item) => `  - ${item.name}${item.required ? " (required)" : " (optional)"}${item.description ? `: ${item.description}` : ""}`,
      );
      return [`- ${category.name}${category.description ? `: ${category.description}` : ""}`, ...(lines.length ? lines : ["  - (no fixed deliverables)"])].join("\n");
    })
    .join("\n");
}

export interface DoneReport {
  category?: string;
  summary?: string;
  deliverables?: Record<string, unknown>;
}

/** What still stands between this report and done; empty when it may close. */
export function checkDone(report: DoneReport, assigned: string | null): string[] {
  const categories = listCategories();
  const claimed = (report.category ?? "").trim();
  // A category set on the run wins over the one Claude picked, unless the run said auto.
  const wanted = assigned && assigned !== "auto" ? assigned : claimed;
  if (!categories.length) return [];
  if (!wanted) return [`Name the category in the done block. It must be one of: ${categories.map((item) => item.name).join(", ")}.`];
  const category = findCategory(wanted);
  if (!category) return [`'${wanted}' is not a category. Use one of: ${categories.map((item) => item.name).join(", ")}.`];

  const given = new Map(
    Object.entries(report.deliverables ?? {}).map(([key, value]) => [key.trim().toLowerCase(), typeof value === "string" ? value.trim() : JSON.stringify(value)]),
  );
  return category.deliverables
    .filter((item) => item.required)
    .filter((item) => {
      const value = given.get(item.name.toLowerCase());
      return !value || value === "null" || value === '""';
    })
    .map((item) => `Missing required deliverable '${item.name}'${item.description ? ` (${item.description})` : ""}.`);
}
