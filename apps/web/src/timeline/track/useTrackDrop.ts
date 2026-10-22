import { useState, type DragEvent } from "react";
import type { Clip, RecipeInfo } from "../../api";
import { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO } from "../../screens/Library";
import { TRANSITIONS, type TransitionKind } from "@afflatus/core";
import { DRAG_TRANSITION, pinInputs, type Slot } from "../model";

/** What is done on the track, as keys and their words: the line under it while nothing is dragged. */
export const LEGEND: ReadonlyArray<{ keys: string; words: string }> = [
  { keys: "drag", words: "media onto the track" },
  { keys: "click", words: "a clip" },
  { keys: "right-click", words: "its menu" },
  { keys: "I O", words: "a range" },
  { keys: "Ctrl+click", words: "picks clips" },
];

/** What a drop would do, worked out while something is dragged over the track. */
export type Over =
  | { kind: "insert"; index: number }
  | { kind: "pin"; clip: string; where: "start" | "end" | "mid"; atS?: number }
  | { kind: "sound"; clip: string }
  | { kind: "music" }
  /** A transition onto the join before this clip. */
  | { kind: "join"; clip: string }
  /** A video onto the source lane. */
  | { kind: "source" }
  /** A voice recording past the clips, or onto an empty clip: made into Lip sync clips cut at its pauses (in that clip's place). */
  | { kind: "recording"; clip?: string }
  /** A recording onto a Lip sync clip's own Audio cell while it has no voice: that clip's voice, nothing else changed. */
  | { kind: "voice"; clip: string };

/**
 * A file from the computer while it hovers: its type is known before the drop (not its name), so a sound lights the clips'
 * sound and the music lane, a video the source lane. A type the browser does not say is taken for a picture, as before.
 */
function fileKindOf(e: DragEvent): "picture" | "video" | "sound" {
  const type = [...e.dataTransfer.items].find((i) => i.kind === "file")?.type ?? "";
  return type.startsWith("audio/") ? "sound" : type.startsWith("video/") ? "video" : "picture";
}

/**
 * What can be dragged over the track by the browser (from the library, the computer, the transitions' strip). A clip of
 * the track itself is moved by the pointer instead (useClipDrag).
 */
export type Dragged = "picture" | "video" | "sound" | "transition";

/**
 * What a drop on a clip would do, by what is dragged and where along the clip it is (`fx`, 0 at its left edge to 1 at its
 * right, the clip `width` px wide): a sound replaces its audio; a transition goes on the nearer join; a picture pins its
 * first frame (left half), its last (right half) or a keyframe (the middle third, to the half second) when the model has
 * that pin, else it goes in beside the clip, as does anything else; near an edge everything goes in beside it. null:
 * nothing happens there.
 */
export function clipTarget(d: Dragged, s: Slot, fx: number, width: number, clips: Clip[], pins: ReturnType<typeof pinInputs>): Over | null {
  // a sound on a clip not rendered yet is a recording to make it Lip sync from (the mock, 2026-10-20); on a rendered clip,
  // or a still, its audio. Nothing on one queued or rendering: made into Lip sync clips in its place, it would be removed
  // while its render runs on (paid for on a rented machine), its video then in no clip
  if (d === "sound" && s.planned && s.clip.job) return null;
  if (d === "sound") return s.planned && s.clip.kind !== "still" ? { kind: "recording", clip: s.clip.id } : { kind: "sound", clip: s.clip.id };
  // a transition goes on the nearer join: before this clip, or before the next one
  if (d === "transition") {
    const at = fx < 0.5 ? s.index : s.index + 1;
    return at > 0 && at < clips.length ? { kind: "join", clip: clips[at]!.id } : null;
  }
  const half: Over = { kind: "insert", index: fx < 0.5 ? s.index : s.index + 1 };
  if (d !== "picture" || s.clip.kind === "still") return half;
  const carries = s.index > 0 && s.clip.joined === "continue";
  const edge = Math.min(0.2, 18 / Math.max(1, width));
  if (fx < edge || fx > 1 - edge) return half;
  // the middle third, for a model that can pass through a picture: pinned at that moment, to the half second
  if (pins.mid && fx > 0.3 && fx < 0.7) {
    const seconds = Math.max(1, s.lengthMs / 1000);
    return { kind: "pin", clip: s.clip.id, where: "mid", atS: Math.max(0.5, Math.round(fx * seconds * 2) / 2) };
  }
  if (fx < 0.5) return pins.start && !carries ? { kind: "pin", clip: s.clip.id, where: "start" } : half;
  return pins.end ? { kind: "pin", clip: s.clip.id, where: "end" } : half;
}

/** What is being dragged over the track, and what dropping it here would do. */
export function useTrackDrop({ clips, slots, end, recipes, onUpload, onInsert, onPin, onClipSound, onMusic, onTransition, onSource, onRecording, onVoice }: {
  clips: Clip[];
  slots: Slot[];
  /** Where the last clip ends, in pixels. */
  end: number;
  recipes: RecipeInfo[];
  onUpload?(file: File): Promise<{ id: string; kind: string } | null>;
  onInsert(asset: string, after: string | null): void;
  onPin(clip: Clip, where: "start" | "end" | "mid", asset: string, atS?: number): void;
  onClipSound(clip: string, asset: string): void;
  onMusic(asset: string): void;
  onTransition?(clip: string, kind: TransitionKind): void;
  /** A video dropped on the source lane. */
  onSource?(asset: string): void;
  /** A voice recording made into Lip sync clips, in place of the empty clip it was dropped on, else at the end. */
  onRecording?(asset: string, clip?: string): void;
  /** A recording made the voice of a Lip sync clip that has none (dropped on its own Audio cell). */
  onVoice?(clip: string, asset: string): void;
}) {

  const [over, setOver] = useState<Over | null>(null);
  const [dragging, setDragging] = useState<Dragged | null>(null);

  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe);

  // ---- what is being dragged, and what dropping it here would do
  const draggedOf = (e: DragEvent) => {
    const t = e.dataTransfer.types;
    return t.includes(DRAG_TRANSITION) ? (onTransition ? "transition" : null) : t.includes(DRAG_PICTURE) ? "picture" : t.includes(DRAG_SOUND) ? "sound" : t.includes(DRAG_VIDEO) || t.includes(DRAG_TYPE) ? "video" : onUpload && t.includes("Files") ? fileKindOf(e) : null;
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
    const r = e.currentTarget.getBoundingClientRect();
    hover(e, clipTarget(d, s, (e.clientX - r.left) / Math.max(1, r.width), r.width, clips, pinInputs(recipeOf(s.clip))));
  };
  /** Something is dragged over a join itself (its dot, its transition): a transition goes on that join. */
  const overJoin = (e: DragEvent, s: Slot) => {
    if (draggedOf(e) !== "transition") return overClip(e, s);
    hover(e, s.index > 0 ? { kind: "join", clip: s.clip.id } : null);
  };
  const drop = (e: DragEvent) => {
    const d = draggedOf(e);
    if (!d) return;
    e.preventDefault();
    const target = over;
    setOver(null);
    setDragging(null);
    if (!target) return;
    if (d === "transition") {
      const kind = e.dataTransfer.getData(DRAG_TRANSITION) as TransitionKind;
      if (target.kind === "join" && kind in TRANSITIONS) onTransition?.(target.clip, kind);
      return;
    }
    const asset = e.dataTransfer.getData(DRAG_TYPE);
    // a file from the computer: into the library first, then placed as the item it became
    const file = !asset ? e.dataTransfer.files[0] : undefined;
    if (file && onUpload) {
      void onUpload(file).then((made) => {
        if (!made) return;
        const picture = made.kind === "image";
        if (target.kind === "pin" && picture) onPin(clips.find((c) => c.id === target.clip)!, target.where, made.id, target.atS);
        else if (target.kind === "sound" && made.kind === "audio") onClipSound(target.clip, made.id);
        else if (target.kind === "music" && made.kind === "audio") onMusic(made.id);
        else if (target.kind === "source" && made.kind === "video") onSource?.(made.id);
        else if (target.kind === "recording" && made.kind === "audio") onRecording?.(made.id, target.clip);
        else if (target.kind === "voice" && made.kind === "audio") onVoice?.(target.clip, made.id);
        else if (made.kind !== "audio" && target.kind !== "music" && target.kind !== "source" && target.kind !== "recording" && target.kind !== "voice") {
          // a picture or video that landed on a clip without a pin to take it: it goes in after that clip
          const index = target.kind === "insert" ? target.index : clips.findIndex((c) => c.id === target.clip) + 1;
          onInsert(made.id, index === 0 ? null : clips[index - 1]!.id);
        }
      });
      return;
    }
    if (target.kind === "insert") {
      if (asset) onInsert(asset, target.index === 0 ? null : clips[target.index - 1]!.id);
    } else if (target.kind === "pin" && asset) onPin(clips.find((c) => c.id === target.clip)!, target.where, asset, target.atS);
    else if (target.kind === "sound" && asset) onClipSound(target.clip, asset);
    else if (target.kind === "music" && asset) onMusic(asset);
    else if (target.kind === "source" && asset) onSource?.(asset);
    else if (target.kind === "recording" && asset) onRecording?.(asset, target.clip);
    else if (target.kind === "voice" && asset) onVoice?.(target.clip, asset);
  };
  const n = (id: string) => clips.findIndex((c) => c.id === id) + 1;
  const hint = !dragging
    ? clips.length
      ? LEGEND.map((l) => `${l.keys.replace("+", " + ")} ${l.words}`).join(" · ")
      : "Your clips will line up here, left to right, in the order they play."
    : !over
      ? dragging === "sound" ? "Drop it past the clips (or on a clip not rendered yet) for Lip sync clips, on a clip to replace its audio, or on the music track." : dragging === "transition" ? "Drop it on a join between two clips." : "Drop it on the timeline."
      : over.kind === "insert"
        ? `Drop to ${dragging === "picture" ? "add this image as a still" : "insert it"} ${over.index === 0 ? "at the start" : over.index >= clips.length ? "at the end" : `between clip ${over.index} and clip ${over.index + 1}`}.`
        : over.kind === "pin"
          ? over.where === "mid" ? `Drop to make this image a keyframe of clip ${n(over.clip)} at ${over.atS} s.` : `Drop to make this image the ${over.where === "start" ? "first" : "last"} frame of clip ${n(over.clip)}.`
          : over.kind === "sound"
            ? `Drop to replace the audio of clip ${n(over.clip)}.`
            : over.kind === "source"
            ? "Drop to make it the source: made into clips window by window (Motion transfer)."
            : over.kind === "recording"
            ? `Drop for Lip sync clips cut at its pauses${over.clip ? `, in place of clip ${n(over.clip)}` : ", after the last clip"}.`
            : over.kind === "voice"
            ? `Drop to make it the voice of clip ${n(over.clip)}.`
            : over.kind === "join"
            ? `Drop to put it on the cut between clip ${n(over.clip) - 1} and clip ${n(over.clip)}${clips[n(over.clip) - 1]?.joined === "continue" ? " (it becomes a cut)" : ""}.`
            : "Drop to play it under the whole video.";
  // nothing dragged and clips on the track: the line is drawn as keys and their words (the LEGEND)
  const legend = !dragging && clips.length > 0;
  const lineAt = over?.kind === "insert" ? (over.index < slots.length ? slots[over.index]!.left : end) : null;

  /** The pointer left the track: nothing is dragged over it any more. */
  const leave = () => {
    setOver(null);
    setDragging(null);
  };
  return { over, dragging, draggedOf, hover, overClip, overJoin, drop, hint, legend, lineAt, leave };
}
