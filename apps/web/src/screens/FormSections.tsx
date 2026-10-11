import { useEffect, useRef, useState, type DragEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import type { Section, Toggle } from "@afflatus/workflows";
import { Button, cx, Help, Toggle as Switch } from "../ui";
import { useFlip } from "../useFlip";
import { ADVANCED, isGroup, isMark, placedIn, PROMPT, reordered, withNew, type Spot } from "./workflowEditor/sections";
import { useCardMoves } from "./workflowEditor/useCardMoves";
import { useItemMoves, type Refocus } from "./workflowEditor/useItemMoves";

/**
 * The form of an imported workflow, arranged: named sections holding the form's inputs in the order
 * they will be read, dragged into place, and switches among them, each holding the settings that show
 * while it is on (as Hires fix holds the upscale settings in the built-in forms). What is placed nowhere
 * keeps its usual place, up front or under Advanced, and sits in a tray below to be dragged in.
 * From the keyboard: Tab walks the settings, Enter (or the menu key, or a right-click) opens "move to" with the
 * places a drag can reach, Alt + ← → moves one within its list and Alt + ↑ ↓ to the section before or after.
 * A card's handle (a section's, the Prompt's, Advanced's) does the same for the card: Enter opens Move up / down, to
 * the top / bottom, and Alt + ↑ ↓ moves it.
 */

const KIND = "application/x-afflatus-form-item";

export interface Placeable {
  id: string;
  label: string;
  /** What kind of setting it is, in a word (number, choice, text, switch…). */
  kind: string;
}

type Drag = { item: string } | { section: string };
type Over = Spot | { before: string } | { tray: true } | null;

const read = (e: DragEvent): Drag | null => {
  try {
    return JSON.parse(e.dataTransfer.getData(KIND)) as Drag;
  } catch {
    return null;
  }
};
const carries = (e: DragEvent) => e.dataTransfer.types.includes(KIND);
const sameSpot = (a: Over, b: Spot) => a !== null && "section" in a && a.section === b.section && a.group === b.group && a.index === b.index;

export function FormSections({ sections, onChange, items, toggles, onMakeSwitch, onDropSwitch, onSwitchDefault, cuts, onSuggest, canSuggest }: {
  sections: Section[];
  /** The sections as they now are, in one change; a switch made here that none holds any more is forgotten with it. */
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
  // a card or a setting put elsewhere (dropped, moved from its menu or with Alt + arrows) slides there, the others
  // moving aside; the cards are told from the settings, as a section's id could be a setting's. Nothing moves while
  // a drag is under way (the order changes only on the drop), so the browser's drag picture is never fought.
  const flip = useFlip(sections.flatMap((s) => [`card:${s.id}`, ...s.items.flatMap((it) => (isGroup(it) ? [`item:${it.toggle}`, ...it.items.map((x) => `item:${x}`), "/"] : [`item:${it}`])), "|"]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set(sections.flatMap((s) => s.items.flatMap((it) => (isGroup(it) ? [it.toggle, ...it.items] : [it]))));
  const loose = items.filter((i) => !placed.has(i.id));

  const update = (id: string, patch: Partial<Section>) => onChange(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const real = sections.filter((s) => !isMark(s));
  const add = () => onChange(withNew(sections).next);
  /** The section goes, and its switches with it (one made here is forgotten by onChange, in the same change). */
  const remove = (s: Section) => onChange(sections.filter((x) => x.id !== s.id));
  /** Put an item at a spot, in one change: the drag, the menu and the Alt + arrow keys all come here. */
  const move = (item: string, to: Spot | null) => {
    const next = placedIn(sections, item, to);
    if (next) onChange(next);
  };
  /** A section dropped on another card, in one change: the drag and the section keys both come here. */
  const reorder = (section: string, before: string) => {
    const next = reordered(sections, section, before);
    if (next) onChange(next);
  };

  // ---- from the keyboard: the same moves, through the same `move` (useItemMoves) and `reordered` (useCardMoves) ----
  const root = useRef<HTMLDivElement>(null);
  /** What takes the focus once the change is drawn: the setting or section moved (in its new place), or a section's name. */
  const refocus = useRef<Refocus>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want || !root.current) return;
    refocus.current = null;
    if ("chip" in want) root.current.querySelector<HTMLElement>(`[data-place="${CSS.escape(want.chip)}"]`)?.focus();
    else if ("head" in want) root.current.querySelector<HTMLElement>(`[data-head="${CSS.escape(want.head)}"]`)?.focus();
    else {
      const name = root.current.querySelector<HTMLInputElement>(`[data-section="${CSS.escape(want.name)}"] input`);
      name?.focus();
      name?.select();
    }
  });
  const { chip, element: itemMenu } = useItemMoves({ sections, onChange, byId, toggles, move, refocus });

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
  const { handle, element: cardMenu } = useCardMoves({ sections, onChange, remove, startSection, refocus });

  const row = "flex h-8 items-center gap-2 rounded-md px-1.5 text-xs";
  const line = (spot: Spot) => (sameSpot(over, spot) ? "border-accent" : "border-transparent");
  /** One setting's row, draggable, with a gap line above it where a drop lands. */
  const settingRow = (id: string, spot: Spot) => {
    const it = byId.get(id);
    if (!it) return null;
    return (
      <div
        key={id}
        ref={flip(`item:${id}`)}
        draggable
        onDragStart={startItem(id)}
        onDragOver={(e) => { if (allow(e)) setOver(spot); }}
        onDrop={dropAt(spot)}
        className={cx(row, "cursor-grab border-t-2 hover:bg-hover", line(spot))}
      >
        <GripVertical size={13} className="shrink-0 text-ink-3" />
        {chip(id, it.label, "min-w-0 grow cursor-grab truncate rounded text-left font-semibold")}
        <span className="shrink-0 text-ink-3">{it.kind}</span>
        {/* out of Tab's walk: the setting's own menu says it too (Advanced) */}
        <button type="button" tabIndex={-1} aria-label={`Take ${it.label} out`} onClick={() => move(id, null)} className="h-6 w-6 shrink-0 rounded text-ink-3 hover:bg-raised hover:text-ink"><X size={12} className="mx-auto" /></button>
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
      ref={flip(`card:${ADVANCED}`)}
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
        {handle(ADVANCED, "Drag to put the Advanced chapter before or after a section; press for Move up / down")}
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Advanced · {loose.length}</span>
        <Help text="Folded in the form; holds what is in no section." />
      </div>
      {loose.length ? (
        <div className="flex flex-wrap gap-1.5">
          {loose.map((it) => (
            <span key={it.id} ref={flip(`item:${it.id}`)} draggable onDragStart={startItem(it.id)} className="inline-flex h-7 cursor-grab items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold">
              <GripVertical size={12} className="text-ink-3" />{chip(it.id, it.label, "cursor-grab rounded")}
            </span>
          ))}
        </div>
      ) : <span className="text-xs text-ink-3">empty: no Advanced chapter</span>}
    </div>
  );

  /** The prompt card: the main text with its helpers, drawn first unless dragged elsewhere. */
  const promptCard = (
    <div
      key={PROMPT}
      ref={flip(`card:${PROMPT}`)}
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
      {handle(PROMPT, "Drag to put the prompt before or after a section; press for Move up / down")}
      <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Prompt</span>
      <Help text="The main text, with Designer and Snippets; its negative prompt under it unless placed." />
    </div>
  );

  return (
    <div ref={root} className="flex flex-col gap-2">
      {!sections.some((s) => s.id === PROMPT) && real.length > 0 && promptCard}
      {sections.map((s) => isMark(s) ? (s.id === PROMPT ? promptCard : advancedCard) : (
        <section
          key={s.id}
          ref={flip(`card:${s.id}`)}
          data-section={s.id}
          aria-label={`Section ${s.label}`}
          className={cx("flex flex-col rounded-xl border bg-panel", over && "before" in over && over.before === s.id ? "border-accent" : "border-line")}
          onDragOver={(e) => { if (allow(e)) setOver({ before: s.id }); }}
          onDragLeave={() => setOver(null)}
          onDrop={dropAt({ section: s.id, group: null, index: s.items.length })}
        >
          <div className="flex items-center gap-1.5 border-b border-line px-1.5 py-1.5">
            {handle(s.id, "Drag to move the section; press for Move up / down")}
            <input
              aria-label="Name of the section" value={s.label} onChange={(e) => update(s.id, { label: e.target.value })}
              className="h-7 min-w-0 grow rounded-md border border-transparent bg-transparent px-1.5 text-sm font-bold hover:border-line focus:border-line-strong focus:outline-none"
            />
            <Button size="sm" onClick={() => onMakeSwitch(s)} className="shrink-0" data-tip="A switch in this section: on, it shows the settings put under it; off, they fold away and the nodes you pick are bypassed"><Plus size={14} /> Switch</Button>
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
                  ref={flip(`item:${item.toggle}`)}
                  draggable
                  onDragStart={startItem(item.toggle)}
                  onDragOver={(e) => { if (allow(e)) setOver(spot); }}
                  onDrop={dropAt(spot)}
                  className={cx("my-0.5 flex flex-col rounded-md border border-line bg-raised border-t-2", line(spot))}
                >
                  <div className={cx(row, "cursor-grab")}>
                    <GripVertical size={13} className="shrink-0 text-ink-3" />
                    {chip(item.toggle, name, "min-w-0 grow cursor-grab truncate rounded text-left font-semibold")}
                    {sw ? (
                      <>
                        <span className="shrink-0 text-ink-3" data-tip={`Off, ${nodes} node${nodes === 1 ? "" : "s"} are bypassed`}>switch · {nodes} node{nodes === 1 ? "" : "s"}</span>
                        <Switch bare label={`${name} starts on`} on={sw.default} onChange={(v) => onSwitchDefault(sw.id, v)} />
                        {sw.made && <Button size="sm" onClick={() => onMakeSwitch(s, sw.id)} className="shrink-0">Edit</Button>}
                      </>
                    ) : <span className="shrink-0 text-ink-3">switch</span>}
                    <button type="button" aria-label={`Take the switch ${name} out`} onClick={() => onDropSwitch(s, item.toggle)} className="h-6 w-6 shrink-0 rounded text-ink-3 hover:bg-hover hover:text-ink"><X size={12} className="mx-auto" /></button>
                  </div>
                  {sw && cuts(sw) && (
                    <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] text-warn-ink">
                      off, bypasses the output node too
                      <Help text={`While it is off, nothing is saved.${sw.made ? " Edit it to leave the output out." : ""}`} />
                    </div>
                  )}
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
        <Button size="sm" onClick={onSuggest} disabled={!canSuggest} data-tip={canSuggest ? "Sections from the frames the author drew, in their order; a switch for each pass the output can do without. A proposal: edit it as you like." : "This workflow has no frames to go by."}>Suggest from the author's frames</Button>
      </div>
      {itemMenu}
      {cardMenu}
    </div>
  );
}
