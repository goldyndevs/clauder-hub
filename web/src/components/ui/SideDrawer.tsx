import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

/**
 * A panel that slides in from the right over the page, opened by its trigger:
 * the session view's corner buttons use it for the hub task's parameters and
 * for what the session is waiting on. Escape, the X or a click outside closes it.
 */
export function SideDrawer({
  trigger,
  title,
  icon,
  badge,
  description,
  open,
  onOpenChange,
  children,
}: {
  trigger: ReactNode;
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** For screen readers; the panel shows only the title. */
  description: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/30 animate-in fade-in-0" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-card shadow-xl focus:outline-none animate-in slide-in-from-right">
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
            {icon}
            {badge}
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="sr-only">{description}</Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="ml-auto" aria-label="Close">
                <X size={15} />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
