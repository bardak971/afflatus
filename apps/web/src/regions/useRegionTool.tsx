import { useRef, useState } from "react";
import { MousePointer2, Square, Type } from "lucide-react";
import { cx } from "../cx";
import { HANDLES, type Handle } from "../stageLayer/frame";
import { percentOf } from "../stageLayer/geometry";
import type { LayerPointer, LayerTool } from "../stageLayer/tools";
import type { Size } from "../viewer/zoom";
import type { LayerPlace } from "../viewer/ZoomPicture";
import { drawnBox, handleOn, isBox, movedBox, newRegionId, pixelBox, regionAt, regionColour, resizedBox, unitPoint } from "./geometry";
import { type RegionKind, type RegionsSpec, type RegionValue, type UnitBox } from "./types";

/** How near a box's edge a press takes its handle, in screen pixels. */
const GRAB_PX = 9;
/** How large a handle is drawn, in screen pixels. */
const HANDLE_PX = 9;
/** How far a press may move, in screen pixels, and still be a click (picking a box) rather than a drag. */
const CLICK_PX = 4;

/** Where each handle sits on a box, as a part of its width and height, and the cursor it shows. */
const AT: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

/** What a region's chip says: its number, its person, then the start of its prompt or its text. */
export function chipSaid(r: RegionValue, n: number, nameOf: (id: string) => string | undefined): string {
  const who = r.cast ? nameOf(r.cast) : undefined;
  const words = (r.kind === "text" ? r.text : r.prompt)?.trim().split(/\s+/).slice(0, 4).join(" ") ?? "";
  const kind = r.kind === "text" && !words ? "Text" : "";
  return [String(n), who && `@${who}`, words || kind].filter(Boolean).join(" · ");
}

type Drag =
  | { how: "draw"; from: { x: number; y: number }; kind?: RegionKind; pick?: string }
  | { how: "move"; id: string; from: { x: number; y: number }; start: UnitBox; moved: boolean }
  | { how: "resize"; id: string; handle: Handle; from: { x: number; y: number }; start: UnitBox };

export interface RegionTools {
  select: LayerTool;
  box: LayerTool;
  /** MOSS's text box (T): drawn as the box is, a box of text. */
  text?: LayerTool;
  /** The boxes with their chips, the one selected with its handles, the one being drawn: drawn by the layer under the tools'. */
  view(place: LayerPlace): React.ReactNode;
}

/**
 * The region tools of the Stage's layer (card #271). V selects: a press on a box picks it and drags it, on a handle of the
 * one picked resizes it, on nothing picks none. B draws a box (T a text box, on MOSS): a drag on the frame draws one, a
 * click on a box picks it, a drag on the picked one moves it. Each box is kept in parts of the frame (geometry.ts); a box
 * is written to the form when the drag ends, and shown as it goes meanwhile. `off`: the family cannot use regions, the boxes
 * shown greyed and nothing drawn.
 */
export function useRegionTool({ spec, regions, natural, selected, onSelect, onChange, nameOf, off }: {
  spec: Pick<RegionsSpec, "max" | "kinds">;
  regions: RegionValue[];
  /** The frame's size in its pixels: the empty frame's, or the picture's the boxes lie over. */
  natural: Size | null;
  selected: string | null;
  onSelect(id: string | null): void;
  onChange(regions: RegionValue[]): void;
  /** A cast person's name, for the chips. */
  nameOf(id: string): string | undefined;
  off?: string;
}): RegionTools {
  const drag = useRef<Drag | null>(null);
  // the box as it is dragged, shown at once; the form gets it when the drag ends
  const [live, setLiveState] = useState<{ id: string; box: UnitBox } | null>(null);
  // held in a ref too: the release can come in the same frame as the last move, before a render
  const liveNow = useRef(live);
  const setLive = (v: { id: string; box: UnitBox } | null) => {
    liveNow.current = v;
    setLiveState(v);
  };
  const place = useRef<LayerPlace | null>(null);
  const max = spec.max;
  const full = regions.length >= max ? `${max} regions already: the most this model takes` : undefined;

  /** A press's point in parts of the frame, and the grab in the picture's pixels (so many screen pixels whatever the zoom). */
  const read = (p: LayerPointer) => {
    const at = place.current;
    const perScreen = at ? at.frame.w / (at.fit.w * at.shown.scale) : 1;
    return { u: unitPoint(p, natural!), grab: GRAB_PX * perScreen, click: (CLICK_PX * perScreen) / Math.max(1, natural!.w) };
  };
  const handleOf = (p: LayerPointer, grab: number): { id: string; handle: Handle; box: UnitBox } | null => {
    const r = regions.find((x) => x.id === selected);
    if (!r || !natural) return null;
    const handle = handleOn(p, pixelBox(r.box, natural), grab);
    return handle ? { id: r.id, handle, box: r.box } : null;
  };
  const startMove = (r: RegionValue, u: { x: number; y: number }) => {
    drag.current = { how: "move", id: r.id, from: u, start: r.box, moved: false };
  };

  const move = (p: LayerPointer) => {
    const d = drag.current;
    if (!d || !natural) return;
    const { u, click } = read(p);
    if (d.how === "draw") setLive({ id: "new", box: drawnBox(d.from, u) });
    else if (d.how === "resize") setLive({ id: d.id, box: resizedBox(d.start, d.handle, u.x - d.from.x, u.y - d.from.y) });
    else if (d.moved || Math.hypot(u.x - d.from.x, u.y - d.from.y) > click) {
      d.moved = true;
      setLive({ id: d.id, box: movedBox(d.start, u.x - d.from.x, u.y - d.from.y) });
    }
  };
  const up = () => {
    const d = drag.current;
    const box = liveNow.current?.box;
    drag.current = null;
    setLive(null);
    if (!d) return;
    if (d.how === "draw") {
      // a click on a box with the box tool picks it; a drag too small to be a box picks nothing new
      if (!box || !isBox(box)) {
        if (d.pick) onSelect(d.pick);
        return;
      }
      if (full) return;
      const id = newRegionId(regions);
      onChange([...regions, { id, box, prompt: "", ...(spec.kinds ? { kind: d.kind ?? "object" } : {}) }]);
      onSelect(id);
      return;
    }
    if (box) onChange(regions.map((r) => (r.id === d.id ? { ...r, box } : r)));
  };
  const cancel = () => {
    drag.current = null;
    setLive(null);
  };

  const ready = natural ? off : "The frame is not drawn yet";
  const select: LayerTool = {
    id: "select", key: "V", label: "Select and move", icon: MousePointer2, cursor: "default",
    tip: "A box: pick it and drag it; its handles resize it. Del removes it",
    disabled: ready,
    down: (p) => {
      if (!natural) return;
      const { u, grab } = read(p);
      const h = handleOf(p, grab);
      if (h) {
        drag.current = { how: "resize", id: h.id, handle: h.handle, from: u, start: h.box };
        return;
      }
      const r = regionAt(regions, u);
      onSelect(r?.id ?? null);
      if (r) startMove(r, u);
    },
    move, up, cancel,
  };
  const drawing = (kind?: RegionKind): Pick<LayerTool, "down" | "move" | "up" | "cancel"> => ({
    down: (p) => {
      if (!natural) return;
      const { u, grab } = read(p);
      const h = handleOf(p, grab);
      if (h) {
        drag.current = { how: "resize", id: h.id, handle: h.handle, from: u, start: h.box };
        return;
      }
      // the picked box is dragged; another one under the press is picked by a click, a drag over it draws a new box
      const r = regionAt(regions, u);
      if (r && r.id === selected) return startMove(r, u);
      drag.current = { how: "draw", from: u, kind, pick: r?.id };
    },
    move, up, cancel,
  });
  const box: LayerTool = {
    id: "box", key: "B", label: "Box: draw a region", icon: Square, cursor: "crosshair",
    tip: "Drag on the frame to draw a region; a click on a box picks it",
    disabled: ready ?? full,
    ...drawing(spec.kinds ? "object" : undefined),
  };
  const text: LayerTool | undefined = spec.kinds ? {
    id: "text", key: "T", label: "Text box", icon: Type, cursor: "crosshair",
    tip: "Drag on the frame to draw a box of text: MOSS writes the words there",
    disabled: ready ?? full,
    ...drawing("text"),
  } : undefined;

  const view = (at: LayerPlace) => {
    place.current = at;
    if (!natural) return null;
    const line = 1 / at.shown.scale;
    const side = HANDLE_PX / at.shown.scale;
    const shown = live && live.id !== "new" ? regions.map((r) => (r.id === live.id ? { ...r, box: live.box } : r)) : regions;
    return (
      <div data-regions className="pointer-events-none absolute inset-0">
        {shown.map((r, i) => {
          const colour = off ? "var(--color-ink-3)" : regionColour(i);
          const on = r.id === selected && !off;
          return (
            <div
              key={r.id}
              data-region={r.id}
              data-selected={on || undefined}
              className={cx("absolute", r.kind === "text" ? "border-dashed" : "border-solid")}
              style={{ ...percentOf(pixelBox(r.box, natural), at.frame), borderColor: colour, borderWidth: line * (on ? 2.5 : 1.5), background: `color-mix(in srgb, ${colour} ${on ? 14 : 8}%, transparent)` }}
            >
              {/* the chip over the box's top left corner: its number, its person, its words */}
              <span
                data-region-chip
                className="absolute left-0 max-w-[220px] truncate rounded-sm font-semibold whitespace-nowrap text-ground"
                style={{ bottom: "100%", marginBottom: line * 2, background: colour, fontSize: 12 / at.shown.scale, padding: `${1 / at.shown.scale}px ${5 / at.shown.scale}px`, maxWidth: 260 / at.shown.scale }}
              >
                {chipSaid(r, i + 1, nameOf)}
              </span>
              {on && HANDLES.map((h) => (
                <i
                  key={h}
                  data-handle={h}
                  className="absolute rounded-key bg-panel"
                  style={{ left: `calc(${AT[h][0] * 100}% - ${side / 2}px)`, top: `calc(${AT[h][1] * 100}% - ${side / 2}px)`, width: side, height: side, border: `${line * 1.5}px solid ${colour}`, cursor: CURSOR[h] }}
                />
              ))}
            </div>
          );
        })}
        {live?.id === "new" && (
          <div data-region-drawing className="absolute border-dashed border-accent" style={{ ...percentOf(pixelBox(live.box, natural), at.frame), borderWidth: line * 2 }} />
        )}
      </div>
    );
  };

  return { select, box, text, view };
}
