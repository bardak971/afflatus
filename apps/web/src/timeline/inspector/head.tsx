import { ArrowUpRight, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import type { Asset, Clip } from "../../api";
import { Chip, Help, IconButton } from "../../ui";
import { FoldButton } from "../column";
import { CloseButton } from "./parts";

/** The Inspector's head: the clip's number and what it is, the way to the clips around, its menu and Close. */
export function ClipHead({ clip, index, shown, before, after, carries, imported, misfit, onSelectClip, onMenu, onClose }: {
  clip: Clip;
  index: number;
  /** What it shows: the still, or the take that plays. */
  shown: Asset | null | undefined;
  before: Clip | undefined;
  after: Clip | undefined;
  /** Its motion carries on from the clip before. */
  carries: boolean;
  /** A video added as it is, with no model to render it. */
  imported: boolean;
  /** Its shape against the video's, when they differ. */
  misfit: { mine: string; video: string } | null;
  onSelectClip?(id: string): void;
  onMenu(e: { preventDefault(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null }): void;
  onClose?(): void;
}) {
  const still = clip.kind === "still";
  const take = clip.take;
  // a neighbour joined to it at another size (enlarged in its render, or finished, when this one is not): the join shows a change of sharpness
  const sizeStep = (() => {
    const px = (a: { width: number | null; height: number | null } | undefined) => (a?.width && a.height ? a.width * a.height : 0);
    const mine = px(take?.asset);
    if (!mine) return null;
    const odd = [clip.joined === "continue" ? before : undefined, after?.joined === "continue" ? after : undefined]
      .find((n) => n?.take && px(n.take.asset) && Math.max(px(n.take.asset), mine) / Math.min(px(n.take.asset), mine) >= 1.5);
    return odd?.take ? { other: odd.take.asset, before: odd === before } : null;
  })();
  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-4 pt-3.5 pb-3">
      <div className="flex items-start gap-2">
        {/* its number and what it is, wrapping as one line: the prompt is in the form below, not said twice */}
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
          <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-chip bg-accent-wash px-2 text-xs font-bold text-accent uppercase">{still ? "Still" : "Clip"} {index + 1}</span>
          <Chip tip={clip.lengthMs && shown?.width && shown.height ? "How long it plays · its size in pixels" : undefined}>
            {clip.lengthMs ? <span className="font-mono">{(clip.lengthMs / 1000).toFixed(1)} s{shown?.width && shown.height ? ` · ${shown.width}×${shown.height}` : ""}</span> : "not rendered yet"}
          </Chip>
          {carries && before && (
            <Chip tone="link" onClick={onSelectClip ? () => onSelectClip(before.id) : undefined} tip={`Its motion carries on from clip ${index}${onSelectClip ? ": open it" : ""}`}>
              extends clip {index}{onSelectClip && <ArrowUpRight size={12} />}
            </Chip>
          )}
          {imported && (
            <Chip>imported video<Help title="Imported video" text="It can be trimmed, and a new clip can extend from any of its frames. It gets no new take, unless you choose a model to render in its place, under Model." /></Chip>
          )}
          {misfit && (
            <Chip tone="attention">{misfit.mine} in a {misfit.video} video<Help title="Another shape" text={`This ${still ? "still" : "clip"} is ${misfit.mine}, the video is ${misfit.video}. ${clip.fill ? "It fills the frame: its edges are cropped." : "It is letterboxed: shown whole, with bars."} Fill frame switches between the two.`} /></Chip>
          )}
          {sizeStep && take && (
            <Chip tone="attention">sharpness jumps at the join<Help title="Another size" text={`This clip is ${take.asset.width} × ${take.asset.height}, the clip ${sizeStep.before ? "before" : "after"} ${sizeStep.other.width} × ${sizeStep.other.height}: one was enlarged and the other not, so the join shows a change of sharpness. Finish all clips (the Finish button above the timeline) to bring every clip to one size the same way, or render both alike.`} /></Chip>
          )}
        </div>
        {onSelectClip && (
          <>
            <IconButton size={28} tone="outline" label="Previous clip" tip={before ? `Clip ${index}` : "This is the first clip"} disabled={!before} onClick={() => before && onSelectClip(before.id)}>
              <ChevronLeft size={15} />
            </IconButton>
            <IconButton size={28} tone="outline" label="Next clip" tip={after ? `Clip ${index + 2}` : "This is the last clip"} disabled={!after} onClick={() => after && onSelectClip(after.id)}>
              <ChevronRight size={15} />
            </IconButton>
          </>
        )}
        {/* the designer is opened from the prompt's own Designer helper, and closed by its × or Escape: not a second button here */}
        <FoldButton />
        {/* Remove clip lives in this menu, with the clip's other actions, not as a button beside Close: one misclick from losing a clip */}
        <IconButton
          size={28}
          label={`More actions on ${still ? "still" : "clip"} ${index + 1}`}
          aria-haspopup="menu"
          tip="More: Duplicate, Move, Remove clip…"
          onClick={(e) => {
            // under the button rather than at the pointer, as a menu button's menu
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ preventDefault: () => e.preventDefault(), clientX: Math.max(1, r.right - 240), clientY: r.bottom + 4 });
          }}
        >
          <MoreHorizontal size={15} />
        </IconButton>
        {onClose && <span className="ml-1.5 flex shrink-0 border-l border-line pl-1.5"><CloseButton onClose={onClose} /></span>}
      </div>
    </div>
  );
}
