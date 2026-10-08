import type { TimelineBrief, TimelineLeaf } from "../../api";
import { aboutMs, clock, size } from "../../format";

/** A frame of a card's film strip: its clip's picture (the playing take, or the still), how wide it is, its number. */
export interface StripFrame {
  /** The asset whose thumbnail it shows; null for a clip still to render (hatched). */
  asset: string | null;
  /** Its share of the strip's width: the clip's length in seconds (one when it is not known). */
  grow: number;
  n: number;
}

/** The clips of the strip, each as wide as it plays; the timeline's cover alone when the list says nothing per clip. */
export function stripOf(t: TimelineBrief): StripFrame[] {
  const ids = t.strip?.length ? t.strip : t.cover ? [t.cover] : [];
  return ids.map((asset, i) => ({ asset, grow: Math.max(0.5, (t.lengths?.[i] ?? 1000) / 1000), n: i + 1 }));
}

/** The facts line: "8 clips · 0:42 · 1024×576 · 839 MB", whatever of it is known; "Empty" for a timeline without clips. */
export function factsOf(t: TimelineBrief, leaf: TimelineLeaf | undefined): string {
  if (!t.clips) return "Empty";
  return [
    `${t.clips} clip${t.clips === 1 ? "" : "s"}`,
    ...(t.durationMs ? [clock(t.durationMs)] : []),
    ...(t.width && t.height ? [`${t.width}×${t.height}`] : []),
    ...(leaf?.bytes ? [size(leaf.bytes)] : []),
  ].join(" · ");
}

export type ChipTone = "warn" | "neutral" | "good";
export interface Chip { label: string; tone: ChipTone; title: string }

/**
 * What needs the owner, as the card's chips: the clips to render (with the learned estimate, when the server has one), joins to
 * redo, the unused takes and their size (as the Projects panel says them), and that it is exported.
 */
export function chipsOf(t: TimelineBrief, leaf: TimelineLeaf | undefined, estimateMs: number | null | undefined): Chip[] {
  const chips: Chip[] = [];
  const about = aboutMs(estimateMs).replace(/^about /, "~");
  if (t.toRender) chips.push({ label: `${t.toRender} to render${about ? ` · ${about}` : ""}`, tone: "warn", title: about ? "Clips with nothing to play yet; the time is learned from your past renders" : "Clips with nothing to play yet" });
  if (t.staleJoins) chips.push({ label: `${t.staleJoins} join${t.staleJoins === 1 ? "" : "s"} to redo`, tone: "warn", title: "A clip changed since the next one was made from it" });
  if (leaf?.unusedTakes) chips.push({ label: `${leaf.unusedTakes} unused · ${size(leaf.unusedBytes)}`, tone: "neutral", title: "Takes no clip plays and nothing else needs: \"Bin unused takes\" sends them to the bin" });
  if (leaf?.exported) chips.push({ label: "exported", tone: "good", title: "It has an export" });
  return chips;
}
