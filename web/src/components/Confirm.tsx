import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

/**
 * The one confirmation in the dashboard. Every action that deletes, stops,
 * writes a file or runs a command asks through useConfirm(); nothing uses the
 * browser's confirm(). `run`, when given, is awaited inside the dialog, so it
 * stays open (and busy) until the action is through, and closes only then;
 * if it throws, the error is shown and the dialog stays.
 */
export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Shown in the dialog's body: a command, a diff, what will be lost. */
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "destructive";
  maxWidth?: string;
  run?: () => Promise<unknown>;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
    setBusy(false);
  };

  const accept = async () => {
    if (!options?.run) return close(true);
    setBusy(true);
    try {
      await options.run();
      close(true);
    } catch (error) {
      // The dialog stays, so the action can be retried or cancelled.
      useStore.getState().notify((error as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <Modal
          open
          onOpenChange={(open) => !open && !busy && close(false)}
          title={options.title}
          description={options.description}
          maxWidth={options.maxWidth ?? "max-w-md"}
          disableOutsideClose={busy}
          footer={
            <>
              <Button disabled={busy} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant={options.tone ?? "primary"} disabled={busy} onClick={() => void accept()} autoFocus>
                {busy ? "Working..." : (options.confirmLabel ?? "Confirm")}
              </Button>
            </>
          }
        >
          {options.body}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm needs a ConfirmProvider above it.");
  return confirm;
}
