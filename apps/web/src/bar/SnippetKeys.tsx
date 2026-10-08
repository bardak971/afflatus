import { useMemo, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { useEntities, useSettings } from "../data";
import { cx } from "../ui";
import { insertSnippet, slugOf, snippetsFor, typedTrigger, type Snippet } from "./snippets";

/**
 * Prompt snippets typed by name in a prompt box (Settings › Command bar, off at first): while `;ci…` is typed,
 * the kit's snippets it starts are listed under the box (↑ ↓, Tab or Enter puts one in, Esc closes the list);
 * a whole name followed by a space or Tab is put in at once. Hands the box its key handler and the list.
 */
export function useSnippetKeys({ value, onChange }: { value: string; onChange(text: string): void }) {
  const on = Boolean(useSettings().data?.bar?.snippets);
  const entities = useEntities();
  const snippets: Snippet[] = useMemo(
    () => (on ? (entities.data?.items ?? []).flatMap((e) => (e.kind === "snippet" ? [{ name: e.name, text: e.def.text }] : [])) : []),
    [on, entities.data],
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const trigger = on && caret !== null ? typedTrigger(value, caret) : null;
  const offered = trigger && closedAt !== trigger.start ? snippetsFor(trigger.word, snippets).slice(0, 6) : [];

  const put = (el: HTMLTextAreaElement, s: Snippet, after = "") => {
    if (!trigger || caret === null) return;
    const next = insertSnippet(value, trigger.start, caret, s.text + after);
    onChange(next.text);
    setCaret(null);
    // once the new text is in the box, the cursor goes after what was put in
    requestAnimationFrame(() => el.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!on || !trigger) return false;
    const el = e.currentTarget;
    if (offered.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + offered.length) % offered.length);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosedAt(trigger.start);
        return true;
      }
      if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        put(el, offered[Math.min(active, offered.length - 1)]!);
        return true;
      }
    }
    // the whole name typed: a space or Tab puts it in
    if ((e.key === " " || e.key === "Tab") && trigger.word) {
      const exact = snippets.find((s) => slugOf(s.name) === trigger.word);
      if (exact) {
        e.preventDefault();
        put(el, exact, e.key === " " ? " " : "");
        return true;
      }
    }
    return false;
  };
  /** Where the cursor is, after each change or move of it. */
  const onSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const at = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (at !== caret) {
      setCaret(at);
      setActive(0);
    }
  };

  const list = offered.length ? (
    <div role="listbox" aria-label="Snippets" className="absolute top-full left-0 z-30 mt-1 flex w-[min(420px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/50">
      {offered.map((s, i) => (
        <button
          key={s.name}
          type="button"
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          // the box keeps the focus: the list is clicked without the cursor leaving it
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const box = (e.currentTarget.closest("[data-snippet-box]")?.querySelector("textarea") ?? null) as HTMLTextAreaElement | null;
            if (box) put(box, s);
          }}
          onMouseMove={() => setActive(i)}
          className={cx("flex items-baseline gap-2.5 px-3 py-1.5 text-left", i === active && "bg-hover")}
        >
          <span className="w-28 shrink-0 truncate font-mono text-xs text-accent">;{slugOf(s.name)}</span>
          <span className="min-w-0 truncate text-xs text-ink-2">{s.text}</span>
        </button>
      ))}
      <span className="border-t border-line px-3 pt-1.5 pb-1 text-[11px] text-ink-3">Tab or Enter puts it in · Esc closes</span>
    </div>
  ) : null;
  return { onKeyDown, onSelect, list };
}
