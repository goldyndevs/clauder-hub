import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/Button";

/** The title block every page opens with, naming the menu group it belongs to. */
export function PageHeader({ group, title, description, action }: { group: string; title: string; description?: string; action?: ReactNode }) {
  return (
    // The actions wrap under the title once the two no longer fit side by side.
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
        <h1 className="text-base font-semibold">{title}</h1>
        {/* One line, always: the full text is on hover. */}
        {description && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={description}>
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex flex-wrap gap-1.5">{action}</div>}
    </div>
  );
}

/** Back from a list's detail to the list, on narrow screens where the two take turns. */
export function BackToList({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" className="-ml-2 mb-3 md:hidden" onClick={onClick}>
      <ChevronLeft size={13} /> Back
    </Button>
  );
}
