import { StatusBadge } from "./StatusBadge";

/** Marks what applies to every project on this machine; always placed right beside a name. */
export function GlobalBadge() {
  return (
    <StatusBadge tone="on" className="px-1 py-0 text-[9px] leading-[14px]" title="Applies to every project on this machine, not only this one.">
      global
    </StatusBadge>
  );
}
