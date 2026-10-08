import type { Asset } from "../../api";

/**
 * The library grid in sections: by the timeline an item is a take of, by the draft that made it, or by day.
 * Takes of one clip stack into one entry (the take that plays on top), opened in place on demand. What
 * belongs to no timeline (or no draft) is left out: that grouping is a filter too. Pure: the grid draws what comes out.
 */
export type GroupBy = "none" | "timeline" | "draft" | "day";

export interface Entry {
  /** The tile shown: the playing take of a stack, else the item itself. */
  asset: Asset;
  /** Of a stack of takes: every take, the playing one first. */
  takes?: Asset[];
  /** The key that opens the stack in place. */
  stack?: string;
}
export interface Section {
  key: string;
  label: string;
  /** What the header says after the name ("5 clips", "3 items"). */
  note: string;
  /** Where the header leads (a timeline). */
  timeline?: string;
  entries: Entry[];
}

const dayOf = (iso: string) => iso.slice(0, 10);
const dayLabel = (day: string) => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
};
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Takes of one clip as one entry, in clip order; the others as they come. `open` holds the stacks shown opened. */
function stacked(items: Asset[], open: Set<string>): Entry[] {
  const byClip = new Map<string, Asset[]>();
  const order: Array<string | Asset> = [];
  for (const a of items) {
    const c = a.clipOf;
    if (!c) {
      order.push(a);
      continue;
    }
    const key = `${c.timeline}:${c.clip}`;
    if (!byClip.has(key)) {
      byClip.set(key, []);
      order.push(key);
    }
    byClip.get(key)!.push(a);
  }
  const out: Entry[] = [];
  for (const o of order) {
    if (typeof o !== "string") {
      out.push({ asset: o });
      continue;
    }
    const takes = byClip.get(o)!.sort((a, b) => Number(b.clipOf!.playing) - Number(a.clipOf!.playing) || a.clipOf!.take - b.clipOf!.take);
    if (takes.length === 1) out.push({ asset: takes[0]! });
    else if (open.has(o)) for (const t of takes) out.push({ asset: t, stack: o, takes });
    else out.push({ asset: takes[0]!, takes, stack: o });
  }
  return out;
}

/** The sections of a list of items. "none" is one section with no header (key ""). */
export function groupItems(items: Asset[], by: GroupBy, open: Set<string>): Section[] {
  if (by === "none") return [{ key: "", label: "", note: "", entries: items.map((asset) => ({ asset })) }];
  const sections = new Map<string, { label: string; timeline?: string; items: Asset[] }>();
  for (const a of items) {
    const key = by === "timeline" ? a.clipOf?.timeline : by === "draft" ? a.draftOf?.id : dayOf(a.createdAt);
    if (!key) continue;
    const label = by === "timeline" ? a.clipOf!.timelineName : by === "draft" ? a.draftOf!.name : dayLabel(key);
    if (!sections.has(key)) sections.set(key, { label, ...(by === "timeline" ? { timeline: key } : {}), items: [] });
    sections.get(key)!.items.push(a);
  }
  const out: Section[] = [];
  for (const [key, s] of sections) {
    // a timeline's clips in their order on it; the rest newest first, as listed
    const list = by === "timeline" ? [...s.items].sort((a, b) => a.clipOf!.clip - b.clipOf!.clip) : s.items;
    const entries = by === "timeline" ? stacked(list, open) : list.map((asset) => ({ asset }));
    const clips = by === "timeline" ? new Set(s.items.map((a) => a.clipOf!.clip)).size : 0;
    out.push({ key, label: s.label, timeline: s.timeline, note: by === "timeline" ? count(clips, "clip") : count(s.items.length, "item"), entries });
  }
  return out;
}
