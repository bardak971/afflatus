import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import type { Section, SwitchGroup, Toggle } from "@afflatus/workflows";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { Button, cx, Help, Toggle as Switch } from "../ui";

/**
 * The form of an imported workflow, arranged: named sections holding the form's inputs in the order
 * they will be read, dragged into place, and switches among them, each holding the settings that show
 * while it is on (as Hires fix holds the upscale settings in the built-in forms). What is placed nowhere
 * keeps its usual place, up front or under Advanced, and sits in a tray below to be dragged in.
 * From the keyboard: Tab walks the settings, Enter (or the menu key, or a right-click) opens "move to" with the
 * places a drag can reach, Alt + ← → moves one within its list and Alt + ↑ ↓ to the section before or after.
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
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set(sections.flatMap((s) => s.items.flatMap((it) => (isGroup(it) ? [it.toggle, ...it.items] : [it]))));
  const loose = items.filter((i) => !placed.has(i.id));

  const update = (id: string, patch: Partial<Section>) => onChange(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const ADVANCED = "advanced";
  const PROMPT = "prompt";
  const isMark = (s: Section) => s.id === ADVANCED || s.id === PROMPT;
  const real = sections.filter((s) => !isMark(s));
  /** The sections with a new one in them: last among the sections; when Advanced was moved up, it stays where it was put. */
  const withNew = () => {
    const made = { id: `sec_${Date.now().toString(36)}`, label: `Section ${real.length + 1}`, items: [] };
    const at = sections.findIndex(isMark);
    const next = [...sections];
    next.splice(at < 0 ? next.length : at, 0, made);
    return { next, made };
  };
  const add = () => onChange(withNew().next);
  /** The section goes, and its switches with it (one made here is forgotten by onChange, in the same change). */
  const remove = (s: Section) => onChange(sections.filter((x) => x.id !== s.id));
  /** Every section without `item` anywhere in it. */
  const without = (list: Section[], item: string): Section[] => list.map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (isGroup(it) ? (it.toggle === item ? [] : [{ ...it, items: it.items.filter((x) => x !== item) }]) : it === item ? [] : [it])) }));
  /**
   * The sections with an item put at a spot (or out of every section when `to` is null); null when it cannot go there.
   * A switch moves with its settings; it cannot go under another switch.
   */
  const placedIn = (list: Section[], item: string, to: Spot | null): Section[] | null => {
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
  };
  /** Put an item at a spot, in one change: the drag, the menu and the Alt + arrow keys all come here. */
  const move = (item: string, to: Spot | null) => {
    const next = placedIn(sections, item, to);
    if (next) onChange(next);
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

  // ---- from the keyboard: the same moves, through the same `move` ----
  const root = useRef<HTMLDivElement>(null);
  /** What takes the focus once the change is drawn: the setting moved (in its new place), or a new section's name. */
  const refocus = useRef<{ chip: string } | { name: string } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want || !root.current) return;
    refocus.current = null;
    if ("chip" in want) root.current.querySelector<HTMLElement>(`[data-place="${CSS.escape(want.chip)}"]`)?.focus();
    else {
      const name = root.current.querySelector<HTMLInputElement>(`[data-section="${CSS.escape(want.name)}"] input`);
      name?.focus();
      name?.select();
    }
  });
  /** Where an item is: its section, the switch it is under, its place in that list. Null: in no section (Advanced). */
  const locate = (id: string) => {
    for (const s of sections) {
      for (const [i, it] of s.items.entries()) {
        if (!isGroup(it)) { if (it === id) return { section: s, group: null, index: i, size: s.items.length }; continue; }
        if (it.toggle === id) return { section: s, group: null, index: i, size: s.items.length };
        const j = it.items.indexOf(id);
        if (j >= 0) return { section: s, group: it, index: j, size: it.items.length };
      }
    }
    return null;
  };
  const switchOf = (id: string) => sections.flatMap((s) => s.items).find((it): it is SwitchGroup => isGroup(it) && it.toggle === id);
  const nameOfSwitch = (id: string) => toggles.find((t) => t.id === id)?.label ?? byId.get(id)?.label ?? id;
  /** A switch made here is forgotten when it leaves every section (as on a drop in the tray). */
  const forgets = (id: string) => Boolean(switchOf(id) && toggles.find((t) => t.id === id)?.made);
  /** The sections in the order they are drawn, Advanced among them: where Alt + ↑ ↓ go. */
  const stops = [...sections.filter((s) => s.id !== PROMPT).map((s) => s.id), ...(sections.some((s) => s.id === ADVANCED) ? [] : [ADVANCED])];
  const put = (id: string, to: Spot | null) => {
    refocus.current = { chip: id };
    move(id, to);
  };
  /** Alt + ← →: one place earlier or later in its list (its section, or the switch it is under). */
  const shift = (id: string, by: -1 | 1) => {
    const at = locate(id);
    if (!at || at.index + by < 0 || at.index + by >= at.size) return;
    put(id, { section: at.section.id, group: at.group?.toggle ?? null, index: at.index + by });
  };
  /** Alt + ↑ ↓: to the end of the section before, or the start of the one after; Advanced is one of them. */
  const hop = (id: string, by: -1 | 1) => {
    const here = locate(id)?.section.id ?? ADVANCED;
    const next = stops[stops.indexOf(here) + by];
    if (!next || (next === ADVANCED && forgets(id))) return;
    if (next === ADVANCED) return put(id, null);
    put(id, { section: next, group: null, index: by < 0 ? (sections.find((s) => s.id === next)?.items.length ?? 0) : 0 });
  };
  /** "A new section…": the item goes into a section made for it, in one change, and its name is ready to be typed. */
  const intoNew = (id: string) => {
    const { next, made } = withNew();
    const placed = placedIn(next, id, { section: made.id, group: null, index: 0 });
    if (!placed) return;
    refocus.current = { name: made.id };
    onChange(placed);
  };
  const keys = (id: string) => (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act = { ArrowLeft: () => shift(id, -1), ArrowRight: () => shift(id, 1), ArrowUp: () => hop(id, -1), ArrowDown: () => hop(id, 1) }[e.key];
    if (!act) return;
    // Alt + ← is also the browser's Back
    e.preventDefault();
    e.stopPropagation();
    act();
  };
  const menu = useMenu<string>();
  /** Enter or a click on a setting, the menu key, a right-click: its "move to" menu. */
  const openMenu = (id: string) => (e: MouseEvent) => {
    e.stopPropagation();
    menu.open(e, id);
  };
  const closeMenu = () => {
    if (menu.menu) refocus.current = { chip: menu.menu.subject };
    menu.close();
  };
  const sectionName = (s: Section) => s.label.trim() || "Untitled section";
  const menuItems = (id: string): MenuItem[] => {
    const at = locate(id);
    const isSwitch = Boolean(switchOf(id));
    const where = at?.group ? nameOfSwitch(at.group.toggle) : at ? sectionName(at.section) : "";
    const places: MenuItem[] = stops.map((stop): MenuItem => {
      if (stop === ADVANCED) {
        const here = !at;
        return { label: "Advanced", note: here ? "here" : forgets(id) ? "the switch is forgotten" : undefined, disabled: here, run: () => put(id, null) };
      }
      const sec = sections.find((s) => s.id === stop)!;
      const here = at?.section.id === stop;
      return {
        label: sectionName(sec),
        note: here && !at.group ? "here" : here && at.group ? `out of ${nameOfSwitch(at.group.toggle)}` : undefined,
        disabled: here && !at.group,
        run: () => put(id, { section: stop, group: null, index: sec.items.length }),
      };
    });
    const groups = sections.flatMap((s) => s.items.filter(isGroup).map((g) => ({ section: s, group: g })));
    const under: MenuItem[] = groups.map(({ section, group }) => {
      const here = at?.group?.toggle === group.toggle;
      return { label: nameOfSwitch(group.toggle), note: here ? "here" : sectionName(section), disabled: here, run: () => put(id, { section: section.id, group: group.toggle, index: group.items.length }) };
    });
    return [
      ...places,
      "—",
      ...(isSwitch ? [] : [under.length ? { label: "Under a switch", items: under } : { label: "Under a switch", note: "none yet", disabled: true }]),
      { label: "A new section…", run: () => intoNew(id) },
      "—",
      ...(at ? [
        { label: `Earlier in ${where}`, key: "Alt + ←", disabled: at.index === 0, run: () => shift(id, -1) },
        { label: `Later in ${where}`, key: "Alt + →", disabled: at.index >= at.size - 1, run: () => shift(id, 1) },
      ] : []),
      { label: "Section up", key: "Alt + ↑", disabled: stops.indexOf(at?.section.id ?? ADVANCED) <= 0, run: () => hop(id, -1) },
      { label: "Section down", key: "Alt + ↓", disabled: (() => { const next = stops[stops.indexOf(at?.section.id ?? ADVANCED) + 1]; return !next || (next === ADVANCED && forgets(id)); })(), run: () => hop(id, 1) },
    ];
  };
  /** What a setting (or a switch) is pressed and walked by: its name, as a button that opens "move to". */
  const chip = (id: string, label: string, className: string) => (
    <button
      type="button"
      data-place={id}
      aria-haspopup="menu"
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
      onClick={openMenu(id)}
      onContextMenu={openMenu(id)}
      onKeyDown={keys(id)}
      className={className}
    >
      {label}
    </button>
  );

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
        <span draggable onDragStart={startSection(ADVANCED)} data-tip="Drag to put the Advanced chapter before or after a section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Advanced · {loose.length}</span>
        <Help text="Folded in the form; holds what is in no section." />
      </div>
      {loose.length ? (
        <div className="flex flex-wrap gap-1.5">
          {loose.map((it) => (
            <span key={it.id} draggable onDragStart={startItem(it.id)} className="inline-flex h-7 cursor-grab items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold">
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
      <span draggable onDragStart={startSection(PROMPT)} data-tip="Drag to put the prompt before or after a section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
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
          data-section={s.id}
          aria-label={`Section ${s.label}`}
          className={cx("flex flex-col rounded-lg border bg-panel", over && "before" in over && over.before === s.id ? "border-accent" : "border-line")}
          onDragOver={(e) => { if (allow(e)) setOver({ before: s.id }); }}
          onDragLeave={() => setOver(null)}
          onDrop={dropAt({ section: s.id, group: null, index: s.items.length })}
        >
          <div className="flex items-center gap-1.5 border-b border-line px-1.5 py-1.5">
            <span draggable onDragStart={startSection(s.id)} data-tip="Drag to move the section" className="cursor-grab text-ink-3"><GripVertical size={14} /></span>
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
      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label={`Move ${byId.get(menu.menu.subject)?.label ?? nameOfSwitch(menu.menu.subject)}`}
          head={{ title: byId.get(menu.menu.subject)?.label ?? nameOfSwitch(menu.menu.subject), sub: "move to" }}
          items={menuItems(menu.menu.subject)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
