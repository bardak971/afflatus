import { useLayoutEffect, useRef, type RefObject } from "react";
import { cx } from "../ui";

/** A render search's token as a chip in the bar's input: where it is in the typed text, and how it is drawn. */
export interface Chip {
  start: number;
  end: number;
  /** key: a key typed; guessed: a bare model's name read as model: (dashed); out: a key with a `-`; off: one that finds nothing. */
  tone: "key" | "guessed" | "out" | "off";
}

const TONE: Record<Chip["tone"], string> = {
  key: "bg-accent/18 py-[3px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]",
  guessed: "outline-1 outline-offset-2 outline-dashed outline-accent/60",
  out: "bg-warn/15 py-[3px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-warn)_15%,transparent)]",
  off: "underline decoration-wavy decoration-warn underline-offset-4",
};

/**
 * The tokens of a render search drawn behind the input: the same text in the same font, transparent but for the chips' tints,
 * so the caret and the selection stay the input's own. The tints grow up and down by padding (an inline span's does not
 * move the text) and sideways by a 1px shadow, not padding, which would move the text under the caret; the mirror follows the input's own scroll on a long line.
 */
export function SearchChips({ text, chips, input }: { text: string; chips: readonly Chip[]; input: RefObject<HTMLInputElement | null> }) {
  const mirror = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    const follow = () => {
      if (mirror.current) mirror.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    };
    follow();
    el.addEventListener("scroll", follow);
    el.addEventListener("keyup", follow);
    el.addEventListener("select", follow);
    return () => {
      el.removeEventListener("scroll", follow);
      el.removeEventListener("keyup", follow);
      el.removeEventListener("select", follow);
    };
  }, [input, text]);
  if (!chips.length) return null;
  const parts: Array<{ text: string; tone?: Chip["tone"] }> = [];
  let at = 0;
  for (const c of [...chips].sort((a, b) => a.start - b.start)) {
    if (c.start < at) continue;
    if (c.start > at) parts.push({ text: text.slice(at, c.start) });
    parts.push({ text: text.slice(c.start, c.end), tone: c.tone });
    at = c.end;
  }
  parts.push({ text: text.slice(at) });
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={mirror} className="flex h-full items-center text-xl font-medium whitespace-pre text-transparent">
        {parts.map((p, i) => (p.tone ? <span key={i} className={cx("rounded-[5px]", TONE[p.tone])}>{p.text}</span> : <span key={i}>{p.text}</span>))}
      </div>
    </div>
  );
}
