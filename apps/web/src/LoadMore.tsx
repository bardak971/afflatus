import { useEffect, useRef } from "react";
import { cx } from "./ui";

/**
 * The end of a list that has more: as it scrolls into view the next page is asked for, so a long library
 * is read by scrolling, not by pressing a button. A quiet line while a page loads; a click asks too, for
 * a list that fits its box without scrolling.
 */
export function LoadMore({ more, busy, onMore, size = "md" }: { more: boolean; busy: boolean; onMore(): void; size?: "md" | "sm" }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !more || busy) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMore();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy, onMore]);
  if (!more) return null;
  return (
    <button type="button" ref={ref} onClick={onMore} disabled={busy} aria-label="More" className={cx("flex w-full justify-center text-ink-3 hover:text-ink-2", size === "sm" ? "py-2 text-[11px]" : "py-4 text-xs")}>
      {busy ? "Loading…" : "more"}
    </button>
  );
}
