import { useState, type DragEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import type { Section, SwitchGroup, Toggle } from "@afflatus/workflows";
import { Button, cx, Toggle as Switch } from "../ui";

/**
 * The form of an imported workflow, arranged: named sections holding the form's inputs in the order
 * they will be read, dragged into place, and switches among them, each holding the settings that show
 * while it is on (as Hires fix holds the upscale settings in the built-in forms). What is placed nowhere
 * keeps its usual place, up front or under Advanced, and sits in a tray below to be dragged in.
 */

const KIND = "application/x-afflatus-form-item";

export interface Placeable {
  id: string;
  label: string;
  /** What kind of setting it is, in a word (number, choice, text, switch…). */
  kind: string;
}

type Drag = { item: string } | { section: string };
/** Where a drop would land: in a section (under one of its switches, or not), before the item at `index`. */
type Spot = { section: string; group: string | null; index: number };
type Over = Spot | { before: string } | { tray: true } | null;

const read = (e: DragEvent): Drag | null => {
  try {
    return JSON.parse(e.dataTransfer.getData(KIND)) as Drag;
  } catch {
    return null;
  }
};
const carries = (e: DragEvent) => e.dataTransfer.types.includes(KIND);
const isGroup = (item: Section["items"][number]): item is SwitchGroup => typeof item !== "string";
const sameSpot = (a: Over, b: Spot) => a !== null && "section" in a && a.section === b.section && a.group === b.group && a.index === b.index;

export function FormSections({ sections, onChange, items, toggles, onMakeSwitch, onDropSwitch, onSwitchDefault, cuts, onSuggest, canSuggest }: {
  sections: Section[];
  onChange(sections: Section[]): void;
  /** Everything that can be placed: the form's inputs, by id. */
  items: Placeable[];
  toggles: Toggle[];
  /** Open the switch dialog: for a new switch in a section, or to change one it has. */
  onMakeSwitch(section: Section, toggle?: string): void;
  /** Take a switch out of its section (its settings go back to the tray). */
  onDropSwitch(section: Section, toggle: string): void;
  onSwitchDefault(id: string, on: boolean): void;
  /** Whether a switch, off, takes the output node with it. */
  cuts(toggle: Toggle): boolean;
  /** A first arrangement from the author's frames, in place of what is there. */
  onSuggest(): void;
  /** False when the workflow has no frames to go by. */
  canSuggest: boolean;
}) {
  const [over, setOver] = useState<Over>(null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set(sections.flatMap((s) => s.items.flatMap((it) => (isGroup(it) ? [it.toggle, ...it.items] : [it]))));
  const loose = items.filter((i) => !placed.has(i.id));

  const update = (id: string, patch: Partial<Section>) => onChange(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const ADVANCED = "advanced";
  const PROMPT = "prompt";
  const isMark = (s: Section) => s.id === ADVANCED || s.id === PROMPT;
  const real = sections.filter((s) => !isMark(s));
  /** A new section goes last among the sections; when Advanced was moved up, it stays where it was put. */
  const add = () => {
    const made = { id: `sec_${Date.now().toString(36)}`, label: `Section ${real.length + 1}`, items: [] };
    const at = sections.findIndex(isMark);
    const next = [...sections];
    next.splice(at < 0 ? next.length : at, 0, made);
    onChange(next);
  };
  const remove = (s: Section) => {
    for (const it of s.items) if (isGroup(it)) onDropSwitch(s, it.toggle);
    onChange(sections.filter((x) => x.id !== s.id));
  };
  /** Every section without `item` anywhere in it. */
  const without = (item: string): Section[] => sections.map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (isGroup(it) ? (it.toggle === item ? [] : [{ ...it, items: it.items.filter((x) => x !== item) }]) : it === item ? [] : [it])) }));
  /** Put an item at a spot (or out of every section when `to` is null). A switch moves with its settings; it cannot go under another switch. */
  const move = (item: string, to: Spot | null) => {
    const group = sections.flatMap((s) => s.items).find((it): it is SwitchGroup => isGroup(it) && it.toggle === item);
    const rest = without(item);
    if (!to) return onChange(rest);
    if (group && to.group) return;
    onChange(rest.map((s) => {
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
    }));
  };
  const reorder = (section: string, before: string) => {
    if (section === before) return;
    // Advanced is placed for the first time: its mark joins the list
    const mark = (id: string): Section | undefined => (id === ADVANCED ? { id: ADVANCED, label: "Advanced", items: [] } : id === PROMPT ? { id: PROMPT, label: "Prompt", items: [] } : undefined);
    const moving = sections.find((s) => s.id === section) ?? mark(section);
    if (!moving) return;
    let rest = sections.filter((s) => s.id !== section);
    // a drop on the Prompt or Advanced card while it has no mark yet: the mark joins the list where the card stood (first, last)
    if (!rest.some((s) => s.id === before)) {
      const m = mark(before);
      if (!m) return;
      rest = before === PROMPT ? [m, ...rest] : [...rest, m];
    }
    const at = rest.findIndex((s) => s.id === before);
    rest.splice(at, 0, moving);
    onChange(rest);
  };

  const startItem = (id: string) => (e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(KIND, JSON.stringify({ item: id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const startSection = (id: string) => (e: DragEvent) => {
    e.dataTransfer.setData(KIND, JSON.stringify({ section: id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const allow = (e: DragEvent) => {
    if (!carries(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    return true;
  };
  const dropAt = (spot: Spot) => (e: DragEvent) => {
    const d = read(e);
    setOver(null);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    if ("item" in d) move(d.item, spot);
    else reorder(d.section, spot.section);
  };
  const dropLoose = (e: DragEvent) => {
    const d = read(e);
    setOver(null);
    if (!d || !("item" in d)) return;
    e.preventDefault();
    move(d.item, null);
  };

  const row = "flex h-8 items-center gap-2 rounded-md px-1.5 text-xs";
  const line = (spot: Spot) => (sameSpot(over, spot) ? "border-accent" : "border-transparent");
  /** One setting's row, draggable, with a gap line above it where a drop lands. */
  const settingRow = (id: string, spot: Spot) => {
    const it = byId.get(id);
    if (!it) return null;
    return (
      <div
        key={id}
        draggable
        onDragStart={startItem(id)}
        onDragOver={(e) => { if (allow(e)) setOver(spot); }}
        onDrop={dropAt(spot)}
        className={cx(row, "cursor-grab border-t-2 hover:bg-hover", line(spot))}
      >
        <GripVertical size={13} className="shrink-0 text-ink-3" />
        <span className="min-w-0 grow truncate font-semibold">{it.label}</span>
        <span className="shrink-0 text-ink-3">{it.kind}</span>
        <button type="button" aria-label={`Take ${it.label} out`} onClick={() => move(id, null)} className="h-6 w-6 shrink-0 rounded text-ink-3 hover:bg-raised hover:text-ink"><X size={12} className="mx-auto" /></button>
      </div>
    );
  };
  /** The gap at the end of a list, where a drop appends. */
  const tail = (spot: Spot, empty: string) => (
    <div onDragOver={(e) => { if (allow(e)) setOver(spot); }} onDrop={dropAt(spot)} className={cx("min-h-6 rounded border-t-2 px-1.5 text-center text-[11px] text-ink-3", line(spot))}>
      {spot.index === 0 ? empty : ""}
    </div>
  );

  /** The Advanced card: what is placed nowhere; dragged like a section to say where the chapter goes. */
  const advancedCard = (
    <div
      key={ADVANCED}
      className={cx("flex flex-col gap-1.5 rounded-lg border border-dashed p-2", over && "tray" in over ? "border-accent" : over && "before" in over && over.before === ADVANCED ? "border-accent" : "border-line")}
      onDragOver={(e) => { if (allow(e)) setOver({ tray: true }); }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        const d = read(e);
        if (d && "section" in d) {
          setOver(null);
          e.preventDefault();
          reorder(d.section, ADVANCED);
        } else dropLoose(e);
      }}
    >
      <div className="flex items-center gap-1.5">
        <span draggable onDragStart={startSection(ADVANCED)} title="Drag to put the Advanced chapter before or after a section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Advanced · {loose.length}</span>
        <span className="text-xs text-ink-2">folded in the form, holds what is in no section</span>
      </div>
      {loose.length ? (
        <div className="flex flex-wrap gap-1.5">
          {loose.map((it) => (
            <span key={it.id} draggable onDragStart={startItem(it.id)} className="inline-flex h-7 cursor-grab items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold">
              <GripVertical size={12} className="text-ink-3" />{it.label}
            </span>
          ))}
        </div>
      ) : <span className="text-xs text-ink-2">Everything is in a section: no Advanced chapter.</span>}
    </div>
  );

  /** The prompt card: the main text with its helpers, drawn first unless dragged elsewhere. */
  const promptCard = (
    <div
      key={PROMPT}
      className={cx("flex items-center gap-1.5 rounded-lg border border-dashed p-2", over && "before" in over && over.before === PROMPT ? "border-accent" : "border-line")}
      onDragOver={(e) => { if (allow(e)) setOver({ before: PROMPT }); }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        const d = read(e);
        setOver(null);
        if (!d || !("section" in d)) return;
        e.preventDefault();
        reorder(d.section, PROMPT);
      }}
    >
      <span draggable onDragStart={startSection(PROMPT)} title="Drag to put the prompt before or after a section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
      <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Prompt</span>
      <span className="text-xs text-ink-2">the main text, with Designer and Snippets; its negative under it unless placed</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {!sections.some((s) => s.id === PROMPT) && real.length > 0 && promptCard}
      {sections.map((s) => isMark(s) ? (s.id === PROMPT ? promptCard : advancedCard) : (
        <section
          key={s.id}
          aria-label={`Section ${s.label}`}
          className={cx("flex flex-col rounded-lg border bg-panel", over && "before" in over && over.before === s.id ? "border-accent" : "border-line")}
          onDragOver={(e) => { if (allow(e)) setOver({ before: s.id }); }}
          onDragLeave={() => setOver(null)}
          onDrop={dropAt({ section: s.id, group: null, index: s.items.length })}
        >
          <div className="flex items-center gap-1.5 border-b border-line px-1.5 py-1.5">
            <span draggable onDragStart={startSection(s.id)} title="Drag to move the section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
            <input
              aria-label="Name of the section" value={s.label} onChange={(e) => update(s.id, { label: e.target.value })}
              className="h-7 min-w-0 grow rounded-md border border-transparent bg-transparent px-1.5 text-sm font-bold hover:border-line focus:border-line-strong focus:outline-none"
            />
            <button type="button" onClick={() => onMakeSwitch(s)} className="h-7 shrink-0 rounded-md border border-line px-2 text-xs hover:bg-hover" title="A switch in this section: on, it shows the settings put under it; off, they fold away and the nodes you pick are bypassed">+ Switch</button>
            <button type="button" aria-label={`Remove the section ${s.label}`} onClick={() => remove(s)} className="h-7 w-7 shrink-0 rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} className="mx-auto" /></button>
          </div>
          <div className="flex flex-col p-1.5">
            {s.items.map((item, index) => {
              const spot = { section: s.id, group: null, index };
              if (!isGroup(item)) return settingRow(item, spot);
              const sw = toggles.find((t) => t.id === item.toggle);
              const name = sw?.label ?? byId.get(item.toggle)?.label ?? item.toggle;
              const nodes = sw?.effects.reduce((n, e) => n + e.nodes.length, 0) ?? 0;
              return (
                <div
                  key={item.toggle}
                  draggable
                  onDragStart={startItem(item.toggle)}
                  onDragOver={(e) => { if (allow(e)) setOver(spot); }}
                  onDrop={dropAt(spot)}
                  className={cx("my-0.5 flex flex-col rounded-md border border-line bg-raised border-t-2", line(spot))}
                >
                  <div className={cx(row, "cursor-grab")}>
                    <GripVertical size={13} className="shrink-0 text-ink-3" />
                    <span className="min-w-0 grow truncate font-semibold">{name}</span>
                    {sw ? (
                      <>
                        <span className="shrink-0 text-ink-3" title={`Off, ${nodes} node${nodes === 1 ? "" : "s"} are bypassed`}>switch · {nodes} node{nodes === 1 ? "" : "s"}</span>
                        <Switch bare label={`${name} starts on`} on={sw.default} onChange={(v) => onSwitchDefault(sw.id, v)} />
                        {sw.made && <button type="button" onClick={() => onMakeSwitch(s, sw.id)} className="h-6 shrink-0 rounded border border-line px-1.5 text-[11px] hover:bg-hover">Edit</button>}
                      </>
                    ) : <span className="shrink-0 text-ink-3">switch</span>}
                    <button type="button" aria-label={`Take the switch ${name} out`} onClick={() => onDropSwitch(s, item.toggle)} className="h-6 w-6 shrink-0 rounded text-ink-3 hover:bg-hover hover:text-ink"><X size={12} className="mx-auto" /></button>
                  </div>
                  {sw && cuts(sw) && <div className="px-2 pb-1 text-[11px] text-warn-ink">Off, the output node is bypassed too: nothing is saved. "Edit" to leave the output out of it.</div>}
                  <div className="ml-5 flex flex-col border-l border-line pl-1.5 pb-1">
                    {item.items.map((id, i) => settingRow(id, { section: s.id, group: item.toggle, index: i }))}
                    {tail({ section: s.id, group: item.toggle, index: item.items.length }, "drop the settings it shows here")}
                  </div>
                </div>
              );
            })}
            {tail({ section: s.id, group: null, index: s.items.length }, "drop settings here")}
          </div>
        </section>
      ))}

      {!sections.some((s) => s.id === ADVANCED) && real.length > 0 && advancedCard}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={add}><Plus size={14} /> Section</Button>
        <Button size="sm" onClick={onSuggest} disabled={!canSuggest} title={canSuggest ? "Sections from the frames the author drew, in their order; a switch for each pass the output can do without. A proposal: edit it as you like." : "This workflow has no frames to go by."}>Suggest from the author's frames</Button>
        <span className="text-xs text-ink-2">{real.length ? "Drag a setting into a section, or under a switch; drag the Prompt and Advanced cards to move those." : "The form is the prompt, your sections in order, and Advanced with everything else."}</span>
      </div>
    </div>
  );
}
