import type { Section, SwitchGroup } from "@afflatus/workflows";

/**
 * The algebra of an imported workflow's form sections (FormSections): pure functions from the sections as they are to the
 * sections after one change, so that the drag, the "move to" menu and the Alt + arrow keys all make the same change.
 */

/** The Advanced card's mark among the sections: where the chapter of what is placed nowhere goes. */
export const ADVANCED = "advanced";
/** The Prompt card's mark among the sections. */
export const PROMPT = "prompt";

/** Where a drop would land: in a section (under one of its switches, or not), before the item at `index`. */
export type Spot = { section: string; group: string | null; index: number };

export const isGroup = (item: Section["items"][number]): item is SwitchGroup => typeof item !== "string";
export const isMark = (s: Section) => s.id === ADVANCED || s.id === PROMPT;

/** The sections with a new one in them: last among the sections; when Advanced was moved up, it stays where it was put. */
export function withNew(sections: Section[], id = `sec_${Date.now().toString(36)}`): { next: Section[]; made: Section } {
  const made = { id, label: `Section ${sections.filter((s) => !isMark(s)).length + 1}`, items: [] };
  const at = sections.findIndex(isMark);
  const next = [...sections];
  next.splice(at < 0 ? next.length : at, 0, made);
  return { next, made };
}

/** Every section without `item` anywhere in it. */
export const without = (list: Section[], item: string): Section[] => list.map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (isGroup(it) ? (it.toggle === item ? [] : [{ ...it, items: it.items.filter((x) => x !== item) }]) : it === item ? [] : [it])) }));

/**
 * The sections with an item put at a spot (or out of every section when `to` is null); null when it cannot go there.
 * A switch moves with its settings; it cannot go under another switch.
 */
export function placedIn(list: Section[], item: string, to: Spot | null): Section[] | null {
  const group = list.flatMap((s) => s.items).find((it): it is SwitchGroup => isGroup(it) && it.toggle === item);
  const rest = without(list, item);
  if (!to) return rest;
  if (group && to.group) return null;
  return rest.map((s) => {
    if (s.id !== to.section) return s;
    if (!to.group) {
      const list: Section["items"] = [...s.items];
      list.splice(Math.min(to.index, list.length), 0, group ?? item);
      return { ...s, items: list };
    }
    return { ...s, items: s.items.map((it): Section["items"][number] => {
      if (!isGroup(it) || it.toggle !== to.group) return it;
      const list = [...it.items];
      list.splice(Math.min(to.index, list.length), 0, item);
      return { ...it, items: list };
    }) };
  });
}

/** The sections with one (or the Prompt or Advanced card) put just before another; null when it cannot go there. */
export function reordered(list: Section[], section: string, before: string): Section[] | null {
  if (section === before) return null;
  // Advanced is placed for the first time: its mark joins the list
  const mark = (id: string): Section | undefined => (id === ADVANCED ? { id: ADVANCED, label: "Advanced", items: [] } : id === PROMPT ? { id: PROMPT, label: "Prompt", items: [] } : undefined);
  const moving = list.find((s) => s.id === section) ?? mark(section);
  if (!moving) return null;
  let rest = list.filter((s) => s.id !== section);
  // a drop on the Prompt or Advanced card while it has no mark yet: the mark joins the list where the card stood (first, last)
  if (!rest.some((s) => s.id === before)) {
    const m = mark(before);
    if (!m) return null;
    rest = before === PROMPT ? [m, ...rest] : [...rest, m];
  }
  const at = rest.findIndex((s) => s.id === before);
  rest.splice(at, 0, moving);
  return rest;
}

/** Where an item is: its section, the switch it is under, its place in that list. Null: in no section (Advanced). */
export function locate(sections: Section[], id: string): { section: Section; group: SwitchGroup | null; index: number; size: number } | null {
  for (const s of sections) {
    for (const [i, it] of s.items.entries()) {
      if (!isGroup(it)) { if (it === id) return { section: s, group: null, index: i, size: s.items.length }; continue; }
      if (it.toggle === id) return { section: s, group: null, index: i, size: s.items.length };
      const j = it.items.indexOf(id);
      if (j >= 0) return { section: s, group: it, index: j, size: it.items.length };
    }
  }
  return null;
}

/** The sections in the order they are drawn, Advanced among them: where Alt + ↑ ↓ go. */
export const stopsOf = (sections: Section[]): string[] => [...sections.filter((s) => s.id !== PROMPT).map((s) => s.id), ...(sections.some((s) => s.id === ADVANCED) ? [] : [ADVANCED])];

/** The cards in the order they are drawn: the Prompt and Advanced cards among them once there is a section of the author's. */
export function cardsOf(sections: Section[]): string[] {
  const real = sections.filter((s) => !isMark(s));
  return [
    ...(!sections.some((s) => s.id === PROMPT) && real.length > 0 ? [PROMPT] : []),
    ...sections.map((s) => s.id),
    ...(!sections.some((s) => s.id === ADVANCED) && real.length > 0 ? [ADVANCED] : []),
  ];
}

/** A card moved up, down, to the top or to the bottom, through `reordered` as a drop does; null when it cannot go there. */
export function cardMoved(sections: Section[], id: string, to: "up" | "down" | "top" | "bottom"): Section[] | null {
  const cards = cardsOf(sections);
  const i = cards.indexOf(id);
  const first = cards[0]!;
  const last = cards[cards.length - 1]!;
  if (i < 0 || ((to === "up" || to === "top") && i === 0) || ((to === "down" || to === "bottom") && i === cards.length - 1)) return null;
  return to === "up" ? reordered(sections, id, cards[i - 1]!)
    : to === "down" ? reordered(sections, cards[i + 1]!, id)
    : to === "top" ? reordered(sections, id, first)
    // there is no drop after the last card: before it, then it before this one
    : (() => { const before = reordered(sections, id, last); return before && reordered(before, last, id); })();
}

/** A section's name as menus say it. */
export const sectionName = (s: Section) => s.label.trim() || "Untitled section";
