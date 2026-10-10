import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import type { Section, SwitchGroup, Toggle } from "@afflatus/workflows";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { ADVANCED, isGroup, locate, placedIn, sectionName, stopsOf, withNew, type Spot } from "./sections";

/** What takes the focus once the change is drawn: the setting or section moved (in its new place), or a section's name. */
export type Refocus = { chip: string } | { head: string } | { name: string } | null;

/**
 * A setting (or a switch) of the form's sections moved from the keyboard: Enter, the menu key or a right-click on it opens
 * "move to" with the places a drag can reach, Alt + ← → moves it within its list and Alt + ↑ ↓ to the section before or
 * after. Every move goes through the same `move` as a drop.
 */
export function useItemMoves({ sections, onChange, byId, toggles, move, refocus }: {
  sections: Section[];
  onChange(sections: Section[]): void;
  byId: Map<string, { label: string }>;
  toggles: Toggle[];
  /** Put an item at a spot, in one change (the drop's own). */
  move(item: string, to: Spot | null): void;
  refocus: RefObject<Refocus>;
}) {
  const switchOf = (id: string) => sections.flatMap((s) => s.items).find((it): it is SwitchGroup => isGroup(it) && it.toggle === id);
  const nameOfSwitch = (id: string) => toggles.find((t) => t.id === id)?.label ?? byId.get(id)?.label ?? id;
  /** A switch made here is forgotten when it leaves every section (as on a drop in the tray). */
  const forgets = (id: string) => Boolean(switchOf(id) && toggles.find((t) => t.id === id)?.made);
  const stops = stopsOf(sections);
  const put = (id: string, to: Spot | null) => {
    refocus.current = { chip: id };
    move(id, to);
  };
  /** Alt + ← →: one place earlier or later in its list (its section, or the switch it is under). */
  const shift = (id: string, by: -1 | 1) => {
    const at = locate(sections, id);
    if (!at || at.index + by < 0 || at.index + by >= at.size) return;
    put(id, { section: at.section.id, group: at.group?.toggle ?? null, index: at.index + by });
  };
  /** Alt + ↑ ↓: to the end of the section before, or the start of the one after; Advanced is one of them. */
  const hop = (id: string, by: -1 | 1) => {
    const here = locate(sections, id)?.section.id ?? ADVANCED;
    const next = stops[stops.indexOf(here) + by];
    if (!next || (next === ADVANCED && forgets(id))) return;
    if (next === ADVANCED) return put(id, null);
    put(id, { section: next, group: null, index: by < 0 ? (sections.find((s) => s.id === next)?.items.length ?? 0) : 0 });
  };
  /** "A new section…": the item goes into a section made for it, in one change, and its name is ready to be typed. */
  const intoNew = (id: string) => {
    const { next, made } = withNew(sections);
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
  const menuItems = (id: string): MenuItem[] => {
    const at = locate(sections, id);
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
        { label: `Earlier in ${where}`, key: "Alt+←", disabled: at.index === 0, run: () => shift(id, -1) },
        { label: `Later in ${where}`, key: "Alt+→", disabled: at.index >= at.size - 1, run: () => shift(id, 1) },
      ] : []),
      { label: "Section up", key: "Alt+↑", disabled: stops.indexOf(at?.section.id ?? ADVANCED) <= 0, run: () => hop(id, -1) },
      { label: "Section down", key: "Alt+↓", disabled: (() => { const next = stops[stops.indexOf(at?.section.id ?? ADVANCED) + 1]; return !next || (next === ADVANCED && forgets(id)); })(), run: () => hop(id, 1) },
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
  const element = menu.menu && (
    <ContextMenu
      at={menu.menu.at}
      label={`Move ${byId.get(menu.menu.subject)?.label ?? nameOfSwitch(menu.menu.subject)}`}
      head={{ title: byId.get(menu.menu.subject)?.label ?? nameOfSwitch(menu.menu.subject), sub: "move to" }}
      items={menuItems(menu.menu.subject)}
      onClose={closeMenu}
    />
  );
  return { chip, element };
}
