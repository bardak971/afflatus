import type { DragEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { GripVertical } from "lucide-react";
import type { Section } from "@afflatus/workflows";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { ADVANCED, cardMoved, cardsOf, PROMPT, sectionName } from "./sections";
import type { Refocus } from "./useItemMoves";

/**
 * Whole sections (and the Prompt and Advanced cards) moved from the keyboard: the cards in the order they are drawn, moved
 * through `reordered` as a drop does. A card's handle opens Move up / down, to the top / bottom; Alt + ↑ ↓ moves it.
 */
export function useCardMoves({ sections, onChange, remove, startSection, refocus }: {
  sections: Section[];
  onChange(sections: Section[]): void;
  /** The section goes, and its switches with it. */
  remove(s: Section): void;
  /** The drag of a card, started on its handle. */
  startSection(id: string): (e: DragEvent) => void;
  refocus: RefObject<Refocus>;
}) {
  const cards = cardsOf(sections);
  const cardName = (id: string) => (id === PROMPT ? "Prompt" : id === ADVANCED ? "Advanced" : sectionName(sections.find((s) => s.id === id)!));
  /** Up, down, to the top or to the bottom, in one change; the focus stays on the card's head. */
  const moveCard = (id: string, to: "up" | "down" | "top" | "bottom") => {
    const next = cardMoved(sections, id, to);
    if (!next) return;
    refocus.current = { head: id };
    onChange(next);
  };
  const cardKeys = (id: string) => (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act = { ArrowUp: () => moveCard(id, "up"), ArrowDown: () => moveCard(id, "down") }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };
  const cardMenu = useMenu<string>();
  const openCardMenu = (id: string) => (e: MouseEvent) => {
    e.stopPropagation();
    cardMenu.open(e, id);
  };
  const closeCardMenu = () => {
    if (cardMenu.menu) refocus.current = { head: cardMenu.menu.subject };
    cardMenu.close();
  };
  const cardItems = (id: string): MenuItem[] => {
    const i = cards.indexOf(id);
    const top = i <= 0;
    const bottom = i >= cards.length - 1;
    const sec = id === PROMPT || id === ADVANCED ? undefined : sections.find((s) => s.id === id);
    return [
      { label: "Move up", key: "Alt+↑", disabled: top, run: () => moveCard(id, "up") },
      { label: "Move down", key: "Alt+↓", disabled: bottom, run: () => moveCard(id, "down") },
      { label: "To the top", disabled: top, run: () => moveCard(id, "top") },
      { label: "To the bottom", disabled: bottom, run: () => moveCard(id, "bottom") },
      // the head's own buttons, as menu items (its name is the box beside the handle)
      ...(sec ? [
        "—" as const,
        { label: "Rename", run: () => { refocus.current = { name: sec.id }; } },
        { label: "Remove the section", danger: true, run: () => remove(sec) },
      ] : []),
    ];
  };
  /** A card's handle: dragged to move the card, pressed (Enter, the menu key, a right-click) for its menu. */
  const handle = (id: string, tip: string) => (
    <span draggable onDragStart={startSection(id)} data-tip={tip} className="inline-flex cursor-grab">
      <button
        type="button"
        data-head={id}
        aria-label={`Move ${id === PROMPT || id === ADVANCED ? `the ${cardName(id)} card` : `the section ${cardName(id)}`}`}
        aria-haspopup="menu"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={openCardMenu(id)}
        onContextMenu={openCardMenu(id)}
        onKeyDown={cardKeys(id)}
        className="cursor-grab rounded text-ink-3 hover:text-ink"
      >
        <GripVertical size={14} />
      </button>
    </span>
  );
  const element = cardMenu.menu && (
    <ContextMenu
      at={cardMenu.menu.at}
      label={`Move ${cardName(cardMenu.menu.subject)}`}
      head={{ title: cardName(cardMenu.menu.subject), sub: "section" }}
      items={cardItems(cardMenu.menu.subject)}
      onClose={closeCardMenu}
    />
  );
  return { handle, element };
}
