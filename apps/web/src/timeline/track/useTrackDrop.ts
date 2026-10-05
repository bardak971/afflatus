import { useState, type DragEvent } from "react";
import type { Clip, RecipeInfo } from "../../api";
import { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO } from "../../screens/Library";
import { DRAG_CLIP, pinInputs, type Slot } from "../model";

/** What a drop would do, worked out while something is dragged over the track. */
export type Over =
  | { kind: "insert"; index: number }
  | { kind: "pin"; clip: string; where: "start" | "end" | "mid"; atS?: number }
  | { kind: "sound"; clip: string }
  | { kind: "music" };

/** What is being dragged over the track, and what dropping it here would do. */
export function useTrackDrop({ clips, slots, end, recipes, onUpload, onMove, onInsert, onPin, onClipSound, onMusic }: {
  clips: Clip[];
  slots: Slot[];
  /** Where the last clip ends, in pixels. */
  end: number;
  recipes: RecipeInfo[];
  onUpload?(file: File): Promise<{ id: string; kind: string } | null>;
  onMove(clip: string, after: string | null): void;
  onInsert(asset: string, after: string | null): void;
  onPin(clip: Clip, where: "start" | "end" | "mid", asset: string, atS?: number): void;
  onClipSound(clip: string, asset: string): void;
  onMusic(asset: string): void;
}) {

  const [over, setOver] = useState<Over | null>(null);
  const [dragging, setDragging] = useState<"clip" | "picture" | "video" | "sound" | null>(null);

  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe);

  // ---- what is being dragged, and what dropping it here would do
  const draggedOf = (e: DragEvent) => {
    const t = e.dataTransfer.types;
    // a file from the computer is taken for a picture while it hovers (its kind is only known on the drop)
    return t.includes(DRAG_CLIP) ? "clip" : t.includes(DRAG_PICTURE) ? "picture" : t.includes(DRAG_SOUND) ? "sound" : t.includes(DRAG_VIDEO) || t.includes(DRAG_TYPE) ? "video" : onUpload && t.includes("Files") ? "picture" : null;
  };
  const hover = (e: DragEvent, what: Over | null) => {
    const d = draggedOf(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    if (d !== dragging) setDragging(d);
    setOver((o) => (JSON.stringify(o) === JSON.stringify(what) ? o : what));
  };
  const overClip = (e: DragEvent, s: Slot) => {
    const d = draggedOf(e);
    if (!d) return;
    if (d === "sound") return hover(e, s.planned && s.clip.kind !== "still" ? null : { kind: "sound", clip: s.clip.id });
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width);
    const half: Over = { kind: "insert", index: fx < 0.5 ? s.index : s.index + 1 };
    if (d !== "picture" || s.clip.kind === "still") return hover(e, half);
    const pins = pinInputs(recipeOf(s.clip));
    const carries = s.index > 0 && s.clip.joined === "continue";
    const edge = Math.min(0.2, 18 / Math.max(1, r.width));
    if (fx < edge || fx > 1 - edge) return hover(e, half);
    // the middle third, for a model that can pass through a picture: pinned at that moment, to the half second
    if (pins.mid && fx > 0.3 && fx < 0.7) {
      const seconds = Math.max(1, s.lengthMs / 1000);
      return hover(e, { kind: "pin", clip: s.clip.id, where: "mid", atS: Math.max(0.5, Math.round(fx * seconds * 2) / 2) });
    }
    if (fx < 0.5) return hover(e, pins.start && !carries ? { kind: "pin", clip: s.clip.id, where: "start" } : half);
    return hover(e, pins.end ? { kind: "pin", clip: s.clip.id, where: "end" } : half);
  };
  const drop = (e: DragEvent) => {
    const d = draggedOf(e);
    if (!d) return;
    e.preventDefault();
    const target = over;
    setOver(null);
    setDragging(null);
    if (!target) return;
    const moved = e.dataTransfer.getData(DRAG_CLIP);
    const asset = e.dataTransfer.getData(DRAG_TYPE);
    // a file from the computer: into the library first, then placed as the item it became
    const file = !moved && !asset ? e.dataTransfer.files[0] : undefined;
    if (file && onUpload) {
      void onUpload(file).then((made) => {
        if (!made) return;
        const picture = made.kind === "image";
        if (target.kind === "pin" && picture) onPin(clips.find((c) => c.id === target.clip)!, target.where, made.id, target.atS);
        else if (target.kind === "sound" && made.kind === "audio") onClipSound(target.clip, made.id);
        else if (target.kind === "music" && made.kind === "audio") onMusic(made.id);
        else if (made.kind !== "audio" && target.kind !== "music") {
          // a picture or video that landed on a clip without a pin to take it: it goes in after that clip
          const index = target.kind === "insert" ? target.index : clips.findIndex((c) => c.id === target.clip) + 1;
          onInsert(made.id, index === 0 ? null : clips[index - 1]!.id);
        }
      });
      return;
    }
    if (target.kind === "insert") {
      const afterId = target.index === 0 ? null : clips[target.index - 1]!.id;
      if (moved) {
        if (afterId !== moved && clips[target.index]?.id !== moved) onMove(moved, afterId);
      } else if (asset) onInsert(asset, afterId);
    } else if (target.kind === "pin" && asset) onPin(clips.find((c) => c.id === target.clip)!, target.where, asset, target.atS);
    else if (target.kind === "sound" && asset) onClipSound(target.clip, asset);
    else if (target.kind === "music" && asset) onMusic(asset);
  };
  const n = (id: string) => clips.findIndex((c) => c.id === id) + 1;
  const hint = !dragging
    ? clips.length
      ? "Drag images, videos and audio here from the left. Click a clip to change it; drag its edges to trim it. I and O mark a range."
      : "Your clips will line up here, left to right, in the order they play."
    : !over
      ? dragging === "sound" ? "Drop it on a clip to replace its audio, or on the music track." : "Drop it on the timeline."
      : over.kind === "insert"
        ? `Drop to ${dragging === "clip" ? "move it" : dragging === "picture" ? "add this image as a still" : "insert it"} ${over.index === 0 ? "at the start" : over.index >= clips.length ? "at the end" : `between clip ${over.index} and clip ${over.index + 1}`}.`
        : over.kind === "pin"
          ? over.where === "mid" ? `Drop to make this image a keyframe of clip ${n(over.clip)} at ${over.atS} s.` : `Drop to make this image the ${over.where === "start" ? "first" : "last"} frame of clip ${n(over.clip)}.`
          : over.kind === "sound"
            ? `Drop to replace the audio of clip ${n(over.clip)}.`
            : "Drop to play it under the whole video.";
  const lineAt = over?.kind === "insert" ? (over.index < slots.length ? slots[over.index]!.left : end) : null;

  /** The pointer left the track: nothing is dragged over it any more. */
  const leave = () => {
    setOver(null);
    setDragging(null);
  };
  return { over, dragging, draggedOf, hover, overClip, drop, hint, lineAt, leave };
}
