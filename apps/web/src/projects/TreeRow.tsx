import type { MouseEvent, ReactNode } from "react";
import { Archive, Check, ChevronRight, CircleDashed, Eraser, Film, Folder, FolderKanban, FolderSymlink, FolderX, Inbox, List, Music, PenLine, Pin, Trash2 } from "lucide-react";
import { thumbUrl } from "../api";
import { size } from "../format";
import { cx, TwoStep } from "../ui";
import { type Row } from "./tree";
import { dateTime, shortDate } from "../format";
import type { useTreeDrag } from "./useTreeDrag";

const ICONS: Record<Row["kind"], { icon: ReactNode; tone: string }> = {
  loose: { icon: <FolderX size={16} />, tone: "text-ink-3" },
  inbox: { icon: <Inbox size={16} />, tone: "text-ink-2" },
  project: { icon: <FolderKanban size={16} />, tone: "text-accent" },
  archive: { icon: <Archive size={16} />, tone: "text-ink-3" },
  folder: { icon: <Folder size={16} />, tone: "text-picture" },
  item: { icon: <Music size={14} />, tone: "text-ink-2" },
  bin: { icon: <Trash2 size={16} />, tone: "text-ink-2" },
  timeline: { icon: <Film size={16} />, tone: "text-warn-ink" },
  drafts: { icon: <List size={16} />, tone: "text-ink-2" },
  draft: { icon: <PenLine size={14} />, tone: "text-ink-3" },
  empty: { icon: <CircleDashed size={14} />, tone: "text-ink-3" },
  more: { icon: null, tone: "" },
};
/** A folder of the disk: its own icon and colour, on it and on every folder under it. */
const LINKED = { icon: <FolderSymlink size={16} />, tone: "text-good" };

/** The text with what was searched for marked in it. */
function Lit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-accent/30 px-px text-ink-strong">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

type Renaming = { key: string; name: string } | null;

/** One row of the Projects panel's tree, under the column heads: Name · Holds · Created · Size (no Created in one project's tree). */
export function TreeRow({ r, setSize, posInSet, columns, scoped, q, isPicked, here, ringed, pinned, renaming, setRenaming, commitRename, drag, clearAsk, setClearAsk, clearEmpty, onClick, onMenu, onFold, onMakeRoot }: {
  r: Row;
  /** Its place among its own, said to screen readers: rows out of sight are not drawn. */
  setSize: number | undefined;
  posInSet: number | undefined;
  /** The grid of the columns. */
  columns: string;
  scoped: boolean;
  /** What is searched for, marked in the names that match. */
  q: string;
  isPicked: boolean;
  /** The row lit: the project worked in, or the library's place. */
  here: boolean;
  /** The keys are on it, and moved there: its ring shows. */
  ringed: boolean;
  /** Pinned to the rail (a project or the Inbox). */
  pinned: boolean;
  renaming: Renaming;
  setRenaming(v: Renaming): void;
  commitRename(): Promise<void>;
  drag: ReturnType<typeof useTreeDrag>;
  clearAsk: string | null;
  setClearAsk(key: string | null): void;
  clearEmpty(r: Row): void;
  onClick(e: MouseEvent): void;
  onMenu(e: MouseEvent): void;
  /** Its fold button pressed. */
  onFold(): void;
  /** Its "no root folder" badge clicked: a root folder is made. */
  onMakeRoot(): void;
}) {
  const top = r.depth === 0;
  const icon = r.kind === "folder" && r.linked ? LINKED : ICONS[r.kind];
  const isRenaming = renaming?.key === r.key;
  return (
    <div
      id={`tree-${r.key}`}
      data-key={r.key}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      aria-expanded={r.foldable ? r.open : undefined}
      aria-selected={isPicked}
      draggable={Boolean(r.moving) && !isRenaming}
      onDragStart={(e) => drag.dragStart(r, e)}
      onDragOver={(e) => drag.dragOver(r, e)}
      onDragLeave={(e) => drag.dragLeave(r, e)}
      onDrop={(e) => drag.drop(r, e)}
      onDragEnd={drag.dragEnd}
      onClick={(e) => {
        if (isRenaming) return;
        onClick(e);
      }}
      onContextMenu={onMenu}
      className={cx(
        "grid cursor-pointer items-center gap-2.5 rounded-lg px-2.5 select-none",
        columns,
        top ? "h-10" : "h-[33px]",
        r.kind === "archive" && "mt-2 rounded-t-none border-t border-line",
        // the Bin stays in sight at the foot of the list, however far the tree scrolls: always there to drop on. It
        // looks like every other row: its band is square and of the panel's colour (unseen, but no row shows past
        // its corners), and its looks (over, picked, here, hover) are drawn on a rounded layer inside it, under its text
        r.kind === "bin" && "sticky bottom-0 z-10 rounded-none bg-panel before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-lg",
        drag.over === r.key
          ? r.kind === "bin" ? "before:bg-accent/15 before:shadow-[inset_0_0_0_1.5px_var(--color-accent)]" : "bg-accent/15 shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
          : isPicked
            ? r.kind === "bin" ? "before:bg-picture/15 before:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-picture)_55%,transparent)]" : "bg-picture/15 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-picture)_55%,transparent)]"
            : here
              ? r.kind === "bin" ? "before:bg-accent/10 before:shadow-[inset_3px_0_0_var(--color-accent)]" : "bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]"
              : r.kind === "bin" ? "hover:before:bg-hover" : "hover:bg-hover",
        ringed && "outline-2 -outline-offset-2 outline-accent/70",
        r.faded && "opacity-40",
      )}
    >
      <span className="flex min-w-0 items-center">
        <span className="font-mono text-[13px] whitespace-pre text-ink-3/60">{r.prefix}</span>
        {r.foldable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${r.open ? "Fold" : "Unfold"} ${r.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onFold();
            }}
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-2 outline-none hover:text-ink focus-visible:outline-none"
          >
            <ChevronRight size={14} strokeWidth={2.2} className={cx("transition-transform duration-100", r.open && "rotate-90")} />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {r.kind === "item" && r.asset && r.asset.kind !== "audio" ? (
          <img src={thumbUrl(r.asset.id)} alt="" loading="lazy" draggable={false} className="mr-0.5 h-7 w-10 shrink-0 rounded object-cover" />
        ) : icon.icon && <span className={cx("flex w-[22px] shrink-0 items-center justify-center", r.archived && r.kind === "project" ? "text-ink-3" : icon.tone, r.dim && "opacity-50")}>{icon.icon}</span>}
        {isRenaming ? (
          <input
            autoFocus
            aria-label={`New name for ${r.label}`}
            value={renaming.name}
            maxLength={120}
            onChange={(e) => setRenaming({ key: r.key, name: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              }
            }}
            onBlur={() => void commitRename()}
            className="ml-1.5 h-7 min-w-0 grow rounded-md border border-accent bg-raised px-2 text-sm text-ink outline-none"
          />
        ) : (
          <span
            className={cx(
              "ml-1.5 min-w-0 truncate",
              top ? "text-sm font-bold" : r.kind === "folder" || r.kind === "project" ? "text-[13px] font-semibold" : "text-[13px] font-medium",
              r.kind === "archive" || r.archived || r.dim ? "text-ink-3" : r.kind === "more" ? "text-ink-2 italic" : "text-ink",
            )}
          >
            <Lit text={r.label} q={r.match ? q : ""} />
          </span>
        )}
        {here && !scoped && (
          <span className="ml-2 flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-px text-[11px] font-bold whitespace-nowrap text-accent-ink">
            <Check size={11} strokeWidth={3} /> working in
          </span>
        )}
        {!scoped && (r.kind === "project" || r.kind === "inbox") && pinned && (
          <span aria-label="Pinned to the rail" data-tip="Pinned to the rail" className="ml-2 flex shrink-0 items-center text-ink-3">
            <Pin size={12} />
          </span>
        )}
        {r.noRoot && !r.archived && (
          <button
            type="button"
            tabIndex={-1}
            data-tip={`What is made while working in it lands in no folder. Click: a root folder named ${r.label} is made. Or drop one of its folders here: it becomes the root.`}
            onClick={(e) => {
              e.stopPropagation();
              onMakeRoot();
            }}
            onDragOver={(e) => drag.badgeOver(r, e)}
            onDragLeave={() => drag.overBadge === r.key && drag.setOverBadge(null)}
            onDrop={(e) => drag.badgeDrop(r, e)}
            className={cx(
              "ml-2 shrink-0 rounded-full bg-warn-wash px-2 py-px text-[11px] font-semibold whitespace-nowrap text-warn-ink hover:shadow-[inset_0_0_0_1px_var(--color-warn-ink)]",
              drag.overBadge === r.key && "bg-accent text-accent-ink shadow-[0_0_0_2px_var(--color-accent)]",
            )}
          >
            {drag.overBadge === r.key ? "make it the root" : "no root folder"}
          </button>
        )}
      </span>
      {r.kind === "empty" && drag.refused?.key !== r.key ? (
        <span className="flex min-w-0 items-center" data-asking={clearAsk === r.key || undefined} onClick={(e) => e.stopPropagation()}>
          {clearAsk === r.key ? (
            <TwoStep open stay title={`Delete the ${r.label}`} note="Delete? The open one stays." yes="Delete" cancel="Keep" onCancel={() => setClearAsk(null)} onYes={() => clearEmpty(r)} />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              data-tip="Delete these drafts: no prompt, no name, nothing rendered. The open one stays."
              onClick={(e) => {
                e.stopPropagation();
                setClearAsk(r.key);
              }}
              onMouseDown={(e) => e.preventDefault()}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-ink-2 hover:bg-hover hover:text-warn-ink"
            >
              <Eraser size={12} /> Clear
            </button>
          )}
        </span>
      ) : (
        <span data-tip={r.path} className={cx("min-w-0 truncate text-xs", drag.refused?.key === r.key || r.missing ? "text-warn-ink" : r.dim ? "text-ink-3" : "text-ink-2")}>{drag.refused?.key === r.key ? drag.refused.why : r.meta}</span>
      )}
      {!scoped && <span data-tip={r.created ? dateTime(r.created) : undefined} className="text-right text-xs whitespace-nowrap text-ink-2 tabular-nums">{r.created ? shortDate(r.created) : ""}</span>}
      <span data-tip={r.sizeTip} className="text-right font-mono text-xs whitespace-nowrap text-ink-2">{r.bytes !== null ? size(r.bytes) : ""}</span>
    </div>
  );
}
