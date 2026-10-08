import { useState } from "react";
import { fileUrl, thumbUrl, type RecipeInfo } from "../../api";
import { pinInputs, type Slot } from "../model";
import { fitFrame, frameUrl, PEEK, pinCompare, pinTitle, takeLabel, type PinPlace } from "./peek";
import { PeekCard, PeekFrame } from "./PeekCard";

/** A pinned picture rested on: which clip, which of its pictures, and the small picture on the clip (its place, its proportions). */
export interface PinOver {
  clip: string;
  where: PinPlace;
  el: HTMLImageElement;
}

/**
 * A picture pinned to a clip, shown large on a card above it. Once the clip has a take that plays, the frame
 * the take really starts on, ends on, or passes at the keyframe's moment stands beside it: whether the render
 * landed on the picture reads at a glance.
 */
export function PinPeek({ over, slot, recipe, bounds }: {
  over: PinOver;
  slot: Slot;
  recipe: RecipeInfo | undefined;
  /** The left and right edges it stays between, in viewport pixels. */
  bounds?: { left: number; right: number };
}) {
  const c = slot.clip;
  const pins = pinInputs(recipe);
  const id = pins[over.where];
  const asset = id && typeof c.inputs[id] === "string" ? (c.inputs[id] as string) : null;
  // its size in pixels, read off the whole picture once it has loaded
  const [size, setSize] = useState<{ id: string; w: number; h: number } | null>(null);
  if (!asset) return null;

  const midAtS = pins.midAt !== undefined ? Number(c.inputs[pins.midAt] ?? 2.5) : undefined;
  const take = !slot.planned && c.take ? c.take : null;
  const r = over.el.getBoundingClientRect();
  const top = (over.el.parentElement ?? over.el).getBoundingClientRect().top - 4;
  // no taller than the room over the clip leaves it
  const room = Math.max(90, top - PEEK.margin * 2 - PEEK.footer - (take ? 22 : 0));
  const natural = { w: over.el.naturalWidth, h: over.el.naturalHeight };
  const box = take ? PEEK.pair : PEEK.pin;
  const pinned = fitFrame(natural.w, natural.h, { w: box.w, h: Math.min(box.h, room) });
  const whole = (
    <img
      src={fileUrl(asset)}
      alt=""
      draggable={false}
      onLoad={(e) => setSize({ id: asset, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
  const picture = (
    <span className="relative block shrink-0 overflow-hidden rounded-[10px] bg-black bg-contain bg-center bg-no-repeat" style={{ width: pinned.w, height: pinned.h, backgroundImage: `url(${thumbUrl(asset)})` }}>
      {whole}
    </span>
  );

  let body = picture;
  let width = pinned.w;
  if (take) {
    const at = pinCompare(take, over.where, midAtS);
    const frame = fitFrame(take.asset.width, take.asset.height, { w: box.w, h: Math.min(box.h, room) });
    const n = c.takes.findIndex((t) => t.id === take.id) + 1;
    width = pinned.w + frame.w + 10;
    body = (
      <span className="flex items-center gap-2.5">
        <span className="flex flex-col gap-1.5">
          {picture}
          <Dot className="bg-accent">pinned</Dot>
        </span>
        <span className="flex flex-col gap-1.5">
          <PeekFrame url={frameUrl(take.asset, at.atMs, frame.h)} w={frame.w} h={frame.h} />
          <Dot className="bg-picture">{takeLabel(n, at.shownMs)}</Dot>
        </span>
      </span>
    );
  }

  return (
    <PeekCard x={r.left + r.width / 2} y={top} width={Math.max(width, 300)} bounds={bounds} label={pinTitle(over.where, slot.index + 1, midAtS)}>
      <span className="flex justify-center">{body}</span>
      <span className="flex items-center gap-2 px-1 pt-2.5 pb-0.5 text-xs">
        <span className="shrink-0 font-semibold text-ink">{pinTitle(over.where, slot.index + 1, midAtS)}</span>
        {size?.id === asset && <span className="shrink-0 text-ink-3">{size.w}×{size.h}</span>}
        <span className="grow" />
        <span className="truncate text-[11px] text-ink-3">drop another image to replace it</span>
      </span>
    </PeekCard>
  );
}

/** A label under a picture of the card, after a dot of its colour. */
function Dot({ className, children }: { className: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} />
      {children}
    </span>
  );
}
