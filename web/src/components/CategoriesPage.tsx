import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useLive } from "../lib/store";
import type { Category } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { Section } from "./Charts";
import { useConfirm } from "./Confirm";
import { Button } from "./ui/Button";
import { Empty } from "./ui/Empty";
import { StatusBadge } from "./ui/StatusBadge";

const STARTERS: Array<Omit<Category, "id">> = [
  {
    name: "feature",
    description: "New behaviour",
    deliverables: [
      { name: "PR", description: "link to the pull request", required: true },
      { name: "Documentation", description: "path or link to the docs written or updated", required: true },
      { name: "Test evidence", description: "how it was tested and the result", required: true },
    ],
  },
  {
    name: "bugfix",
    description: "A defect fixed",
    deliverables: [
      { name: "PR", description: "link to the pull request", required: true },
      { name: "RCA", description: "root cause analysis, a few sentences or a file path", required: true },
      { name: "Test evidence", description: "the failing case now passing", required: true },
    ],
  },
];

/**
 * What "done" means for each kind of task. Claude must report every required
 * deliverable. Categories are shown here; they are created and changed in a
 * Claude session for that purpose.
 */
export function CategoriesPage() {
  const live = useLive(() => api.categories(), []);
  const { starting, start } = usePurpose();

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Settings</div>
            <h1 className="text-base font-semibold">Task categories</h1>
            <p className="truncate text-xs text-muted-foreground" title="What counts as done for each kind of task.">What counts as done for each kind of task.</p>
          </div>
          <Button variant="primary" className="shrink-0" disabled={starting} onClick={() => void start("create-category")} title="Opens a Claude session to define a category">
            <Plus size={12} /> New category
          </Button>
        </div>
        {live.data?.map((category) => <CategoryCard key={category.id} category={category} onEdit={() => void start("edit-category", category.id)} onDeleted={live.reload} />)}
        {live.data && !live.data.length && (
          <Empty
            title="No categories yet."
            hint="Without any, a triggered session reports a summary and evidence of its own choosing. Start from the examples, or describe your own to Claude."
          />
        )}
        {live.data && !live.data.length && (
          <div className="flex justify-center">
            <Button onClick={() => void Promise.all(STARTERS.map((item) => api.saveCategory(item))).then(live.reload)}>Add the feature and bugfix examples</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryCard({ category, onEdit, onDeleted }: { category: Category; onEdit: () => void; onDeleted: () => void }) {
  const confirm = useConfirm();
  return (
    <Section
      title={category.name}
      description={category.description || undefined}
      action={
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" title="Edit with Claude" onClick={onEdit}>
            <Pencil size={13} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            onClick={() =>
              void confirm({
                title: `Delete the category '${category.name}'?`,
                description: "Sessions using it can no longer close against it.",
                confirmLabel: "Delete",
                tone: "destructive",
                run: async () => {
                  await api.deleteCategory(category.id);
                  onDeleted();
                },
              })
            }
          >
            <Trash2 size={13} />
          </Button>
        </div>
      }
    >
      {category.deliverables.length ? (
        <div className="divide-y rounded-md border">
          {category.deliverables.map((item) => (
            <div key={item.name} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{item.name}</div>
                {item.description && <div className="break-words text-[11px] text-muted-foreground">{item.description}</div>}
              </div>
              <StatusBadge tone={item.required ? "on" : "off"}>{item.required ? "required" : "optional"}</StatusBadge>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No fixed deliverables.</div>
      )}
    </Section>
  );
}
