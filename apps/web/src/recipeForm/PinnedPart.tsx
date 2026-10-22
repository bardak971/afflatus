import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { GripVertical, Pin } from "lucide-react";
import type { InputSpec } from "@afflatus/core";
import { cx, IconButton } from "../ui";
import { useFlip } from "../useFlip";
import { Part } from "./Part";

/** One pinned setting as the card draws it: whether the form shows it now, and where it lives or why it is not shown. */
export interface PinnedRow {
  spec: InputSpec;
  shown: boolean;
  /** Its section ("Sampling"), or, not shown, what hides it ("Hires fix is off"). */
  from: string;
}

const DRAG_FIELD = "application/x-afflatus-pinned-field";

/**
 * The Pinned card (Pinned fields): the settings pinned for the model's family, at the top of the form, each a live copy of
 * the one in its own section (the same value, the same changed mark and reset), saying where it lives in grey. One the form
 * does not show now stays here, dimmed and out of reach, saying why, rather than vanishing. A pin is reordered by dragging
 * its grip, or with Alt + ↑ ↓ on the grip, as the rail's pinned projects are; right-click on a name, or on a grip, opens the
 * form's menu for it (Unpin, Move up / down, Reset). Folded, its line lists the pinned values.
 */
export function PinnedPart({ rows, summary, draw, menuFor, onMove }: {
  rows: PinnedRow[];
  summary: string;
  /** The setting itself, as its section draws it, with what its name says after it. */
  draw(spec: InputSpec, from: string): ReactNode;
  /** The form's menu for a setting, from a right-click (or the keyboard's menu key) inside its row; `always`: from anywhere in it. */
  menuFor(spec: InputSpec, always?: boolean): (e: MouseEvent) => void;
  /** Put a pin before the one at `slot` of the card (the rows' length: last). */
  onMove(id: string, slot: number): void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  // the slot a dragged pin lands on: before the row of that index, or the rows' length for after the last
  const [over, setOver] = useState<number | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const flip = useFlip(rows.map((r) => r.spec.id), dragging !== null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  const dragOver = (k: number, e: DragEvent<HTMLElement>) => {
    if (!dragging || !e.dataTransfer.types.includes(DRAG_FIELD)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    setOver(e.clientY > box.top + box.height / 2 ? k + 1 : k);
  };
  return (
    <Part id="pinned" title={`Pinned · ${rows.length}`} icon={<Pin size={13} aria-hidden className="shrink-0 text-accent" />} accent summary={summary} startOpen>
      <div role="list" aria-label="Pinned fields" className="flex flex-col gap-2">
        {rows.map((r, k) => {
          const label = r.spec.label;
          return (
            <div
              key={r.spec.id}
              role="listitem"
              ref={(el) => {
                flip(r.spec.id)(el);
                if (el) rowEls.current.set(r.spec.id, el);
                else rowEls.current.delete(r.spec.id);
              }}
              data-pinned-input={r.spec.id}
              onContextMenu={menuFor(r.spec, !r.shown)}
              onDragOver={(e) => dragOver(k, e)}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragging;
                const at = over;
                end();
                if (from && at !== null) onMove(from, at);
              }}
              className={cx(
                "group relative -ml-1.5 flex min-w-0 items-start gap-0.5",
                dragging === r.spec.id && "opacity-40",
                // the line a dragged pin lands on: above this row, or under the last one
                over === k && "before:absolute before:-top-[5px] before:right-0 before:left-0 before:h-0.5 before:rounded-full before:bg-accent",
                over === k + 1 && k === rows.length - 1 && "after:absolute after:right-0 after:-bottom-[5px] after:left-0 after:h-0.5 after:rounded-full after:bg-accent",
              )}
            >
              <IconButton
                size={28}
                data-pin-grip=""
                label={r.shown ? `Move ${label}` : `Move ${label} (not shown now: ${r.from})`}
                tip="Drag, or Alt + ↑ ↓, to reorder the pins; right-click for Unpin"
                draggable
                onDragStart={(e) => {
                  setDragging(r.spec.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(DRAG_FIELD, r.spec.id);
                  // the whole row goes with the pointer, not the grip alone: what is moved is the setting
                  const row = rowEls.current.get(r.spec.id);
                  if (row) e.dataTransfer.setDragImage(row, 14, 18);
                }}
                onDragEnd={end}
                // the keyboard's way to reorder, as the rail's pins and form sections: the grip keeps the focus as it moves
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  if (e.key === "ArrowUp" && k > 0) onMove(r.spec.id, k - 1);
                  if (e.key === "ArrowDown" && k < rows.length - 1) onMove(r.spec.id, k + 2);
                }}
                className="mt-2 cursor-grab text-ink-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
              >
                <GripVertical size={14} />
              </IconButton>
              {/* not shown by the form now: dimmed and out of reach (a right-click falls through to the row, for Unpin) */}
              <div className={cx("min-w-0 grow", !r.shown && "opacity-50")} inert={!r.shown}>
                {draw(r.spec, r.from)}
              </div>
            </div>
          );
        })}
      </div>
    </Part>
  );
}
