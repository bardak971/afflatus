import type { CSSProperties, MouseEvent } from "react";
import { ArrowLeftRight } from "lucide-react";
import { cx } from "../ui";
import { MIRRORED_TIP } from "./menus";

/** The class a pinned frame's thumbnail takes while it is mirrored at render time: shown flipped, as it will be sent. */
export const flipped = (on: boolean | undefined) => (on ? "-scale-x-100" : undefined);

/**
 * The small ↔ on the corner of a mirrored pinned frame, only while it is on; its tooltip says what it means. A right-click on it
 * opens the frame's menu, as one on the frame does.
 */
export function MirrorMark({ className, style, onMenu }: { className?: string; style?: CSSProperties; onMenu?(e: MouseEvent): void }) {
  return (
    <span
      data-tip={MIRRORED_TIP}
      aria-label="Mirrored at render time"
      onContextMenu={onMenu}
      style={style}
      className={cx("absolute z-[1] flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ground bg-accent text-accent-ink", className)}
    >
      <ArrowLeftRight size={9} strokeWidth={3} />
    </span>
  );
}
