import { Bell } from "lucide-react";
import { api } from "../lib/api";
import { useLive, useStore } from "../lib/store";
import { InteractionCard } from "./InteractionCard";
import { Empty } from "./ui/Empty";

/** Everything any session is waiting on, plus what was answered lately and where. */
export function InboxPage() {
  const open = useStore((state) => state.open);
  const history = useLive(() => api.interactions(), ["interactions"]);
  const past = (history.data ?? []).filter((item) => item.status !== "open").slice(0, 60);

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Operation</div>
          <h1 className="text-base font-semibold">Inbox</h1>
          <p className="truncate text-xs text-muted-foreground" title="What sessions are waiting on. The first answer wins, from anywhere.">What sessions are waiting on. The first answer wins, from anywhere.</p>
        </div>
        {open.length ? (
          <div className="space-y-2">
            {open.map((item) => (
              <InteractionCard key={item.id} interaction={item} showSession />
            ))}
          </div>
        ) : (
          <Empty icon={Bell} title="Nothing is waiting on you." />
        )}
        {past.length > 0 && (
          <div className="space-y-2">
            <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent</h2>
            {past.map((item) => (
              <InteractionCard key={item.id} interaction={item} showSession compact />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
