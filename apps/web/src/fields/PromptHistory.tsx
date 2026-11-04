import { useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { api, thumbUrl } from "../api";
import { when } from "../format";
import { queryKeys } from "../queryKeys";
import { cx } from "../ui";

/** The prompts offered at once: the newest; Ctrl+K's `prompt:` searches all of them. */
const SHOWN = 8;

/**
 * The prompts rendered before, at the prompt box: ↑ in an empty box (or the clock in its corner) lists the newest under it,
 * as Ctrl+K's `prompt:` reads them (promptHistory.ts); ↑ ↓ moves, Enter or Tab puts one in the box in place of its text,
 * Esc closes. Asked of the server only when the list opens. Hands the box its key handler, the list and the button.
 */
export function usePromptHistory({ value, onChange, label }: { value: string; onChange(text: string): void; label: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const history = useQuery({ queryKey: queryKeys.promptHistory.search(""), queryFn: ({ signal }) => api.promptHistory("", SHOWN, { signal }), enabled: open });
  // the prompt in the box already is not offered again
  const items = (history.data?.items ?? []).filter((h) => h.prompt !== value.trim());

  const show = () => {
    setActive(0);
    setOpen(true);
  };
  const put = (el: HTMLTextAreaElement | null, text: string) => {
    onChange(text);
    setOpen(false);
    // the cursor at the end of what was put in, the box keeping the focus
    if (el) requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (!open) {
      // only in an empty box: in a written one ↑ moves the cursor, as it always did
      if (e.key === "ArrowUp" && bare && !e.currentTarget.value) {
        e.preventDefault();
        show();
        return true;
      }
      return false;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return true;
    }
    if (!items.length) {
      // nothing to pick yet (or ever): a key typed closes the list and does what it does
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") setOpen(false);
      return e.key === "ArrowUp" || e.key === "ArrowDown";
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare) {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && bare) {
      e.preventDefault();
      put(e.currentTarget, items[Math.min(active, items.length - 1)]!.prompt);
      return true;
    }
    // writing closes it
    setOpen(false);
    return false;
  };

  const boxOf = (el: Element) => (el.closest("[data-snippet-box]")?.querySelector("textarea") ?? null) as HTMLTextAreaElement | null;
  const list = open ? (
    <div role="listbox" aria-label={`${label}: recent prompts`} className="absolute top-full left-0 z-30 mt-1 flex w-[min(520px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/50">
      {items.map((h, i) => (
        <button
          key={`${h.createdAt}:${i}`}
          type="button"
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          // the box keeps the focus: the list is clicked without the cursor leaving it
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => put(boxOf(e.currentTarget), h.prompt)}
          onMouseMove={() => setActive(i)}
          data-tip={h.prompt.length > 140 ? h.prompt : undefined}
          className={cx("flex items-center gap-2.5 px-3 py-1.5 text-left", i === active && "bg-hover")}
        >
          {h.assetId ? <img src={thumbUrl(h.assetId)} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded-md bg-raised object-cover" /> : <span className="h-8 w-8 shrink-0 rounded-md bg-raised" />}
          <span className="line-clamp-2 min-w-0 grow text-xs break-words text-ink-2">{h.prompt}</span>
          <span className="shrink-0 text-meta text-ink-3">{when(h.createdAt)}</span>
        </button>
      ))}
      {!items.length && <span className="px-3 py-2 text-xs text-ink-3">{history.isPending ? "Reading the prompts…" : history.isError ? "The prompts could not be read" : "No prompt rendered yet"}</span>}
      <span className="border-t border-line px-3 pt-1.5 pb-1 text-meta text-ink-3">Enter or Tab puts it in · Esc closes · Ctrl+K, prompt: searches them all</span>
    </div>
  ) : null;

  const button = (
    <button
      type="button"
      aria-label={`${label}: recent prompts`}
      aria-expanded={open}
      data-tip="Recent prompts (↑ in an empty prompt)"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (open) return setOpen(false);
        boxOf(e.currentTarget)?.focus();
        show();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
    >
      <History size={13} />
    </button>
  );
  return { onKeyDown, list, button, close: () => setOpen(false) };
}
