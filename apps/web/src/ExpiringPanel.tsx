import type { RefObject } from "react";
import { Eye, Star } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { daysSaid } from "./keepFor";
import { Popover } from "./Popover";
import type { expiringSaid, useKeepAllExpiring } from "./screens/studio/expiring";
import { Button, ErrorNote, Help } from "./ui";

/** What the expiring chip's ? says: the rule, once, with the days Settings › Storage gives. */
const expiringHelp = (unkeptDays: number, binDays: number) =>
  `Renders nobody kept go to the bin by themselves ${daysSaid(unkeptDays)} after they were made (or unkept), and ${binDays ? `are deleted ${daysSaid(binDays)} later` : "stay there until it is emptied"}. S keeps one; what is on a timeline is always kept. Settings › Storage says how long.`;

/**
 * The expiring chip's panel (`open`) and its right-click menu (`menuAt`), for StatusBar.tsx's Expiring: when the last
 * goes, show only them in the library, or keep them all. A chunk of its own, fetched while the page is idle.
 */
export function ExpiringPanel({ anchor, open, menuAt, count, said, where, keepFor, keep, onShow, onKeepAll, onClose, onMenuClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  menuAt: Parameters<typeof ContextMenu>[0]["at"] | null;
  count: number;
  said: NonNullable<ReturnType<typeof expiringSaid>>;
  where: string;
  keepFor: { unkeptDays: number; binDays: number };
  keep: ReturnType<typeof useKeepAllExpiring>["keep"];
  onShow(): void;
  onKeepAll(): void;
  onClose(): void;
  onMenuClose(): void;
}) {
  return (
    <>
      {open && (
        <Popover anchor={anchor} onClose={onClose} label="Expiring renders" width={340} height={150}>
          <div className="flex flex-col gap-2.5 p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">{count} expiring in {where}</span>
              <Help text={expiringHelp(keepFor.unkeptDays, keepFor.binDays)} />
            </div>
            <span className="text-xs text-ink-2">{said.next === said.last ? `They go to the bin in ${said.next}` : `The next goes to the bin in ${said.next}, the last in ${said.last}`}</span>
            {keep.isError && <ErrorNote>{keep.error.message}</ErrorNote>}
            <div className="flex gap-2">
              <Button size="sm" tone="primary" onClick={onShow} data-tip="The library, showing only what expires (Filters › Expiring only)">Show them</Button>
              <Button size="sm" disabled={keep.isPending} onClick={onKeepAll} data-tip="They stay until you bin them">{keep.isPending ? "Keeping…" : `Keep all ${count}`}</Button>
            </div>
          </div>
        </Popover>
      )}
      {menuAt && (
        <ContextMenu
          at={menuAt}
          label="Expiring renders"
          head={{ title: `${count} expiring`, sub: `the next in ${said.next}` }}
          items={[
            { label: "Show them", icon: <Eye size={14} />, note: "Expiring only", run: onShow },
            { label: `Keep all ${count}`, icon: <Star size={14} />, disabled: keep.isPending, run: onKeepAll },
          ]}
          onClose={onMenuClose}
        />
      )}
    </>
  );
}
