import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../ui";
import { Lru, PEEK, placeCard } from "./peek";

/** The pictures loaded lately, decoded: a frame seen again shows at once. */
const loaded = new Lru<string, HTMLImageElement>(48);
/** Loads not finished yet, oldest first: past a few, the oldest is let go, so that the newest is not kept waiting behind them. */
const pending: HTMLImageElement[] = [];
const IN_FLIGHT = 3;

/** Loads a picture and decodes it, once; resolves when it can be drawn at once. */
export function preload(url: string): Promise<void> {
  if (loaded.has(url)) return Promise.resolve();
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  pending.push(img);
  while (pending.length > IN_FLIGHT) pending.shift()!.src = "";
  return img.decode().then(
    () => {
      loaded.set(url, img);
      const at = pending.indexOf(img);
      if (at >= 0) pending.splice(at, 1);
    },
    (e: unknown) => {
      const at = pending.indexOf(img);
      if (at >= 0) pending.splice(at, 1);
      throw e;
    },
  );
}

/**
 * The picture to draw for `url`: the last one that has loaded, until the next is ready. A picture asked for
 * after another one replaces it as soon as it is decoded, even when a later one is on its way, so that moving
 * the pointer quickly still shows frames along the way; one that arrives after a later one is dropped.
 */
function useSteadySrc(url: string | null): string | null {
  const [shown, setShown] = useState<string | null>(() => (url && loaded.has(url) ? url : null));
  const asked = useRef(0);
  const drawn = useRef(0);
  useEffect(() => {
    if (!url) return;
    const n = ++asked.current;
    if (loaded.has(url)) {
      drawn.current = n;
      setShown(url);
      return;
    }
    preload(url).then(() => {
      if (n < drawn.current) return;
      drawn.current = n;
      setShown(url);
    }, () => {});
  }, [url]);
  return shown;
}

/** A picture of the card: the last one loaded stays up until the next one is ready, on the stage, never stretched. */
export function PeekFrame({ url, under, w, h, className }: {
  url: string | null;
  /** A picture already at hand, drawn under it while it loads (a pinned picture's small version). */
  under?: string;
  w: number;
  h: number;
  className?: string;
}) {
  const src = useSteadySrc(url);
  return (
    <span className={cx("relative block shrink-0 overflow-hidden rounded-[10px] bg-stage", className)} style={{ width: w, height: h, backgroundImage: under ? `url(${under})` : undefined, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }}>
      {src && <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />}
    </span>
  );
}

/** "Not rendered yet": the card's short stand-in for a frame that does not exist. */
export function PeekEmpty({ children, w = 300 }: { children: ReactNode; w?: number }) {
  return (
    <span className="flex h-[92px] items-center justify-center rounded-[10px] bg-[repeating-linear-gradient(45deg,var(--color-hover)_0_8px,var(--color-panel)_8px_16px)] text-[13px] text-ink-2" style={{ width: w }}>
      {children}
    </span>
  );
}

/** The card's footer: what it shows on the left, in bold, then a dim detail; on the right, the moment or a note. */
export function PeekFooter({ title, detail, right, mono, hint }: { title: string; detail?: string; right?: string; mono?: boolean; hint?: string }) {
  return (
    <>
      <span className="flex items-center gap-2 px-1 pt-[9px] pb-0.5 text-xs">
        <span className="min-w-0 truncate font-semibold text-ink">{title}</span>
        {detail && <span className="shrink-0 text-ink-3">{detail}</span>}
        <span className="grow" />
        {right && <span className={cx("shrink-0", mono ? "font-mono text-accent" : "text-[11px] text-ink-3")}>{right}</span>}
      </span>
      {hint && <span className="block truncate px-1 pt-0.5 pb-0.5 text-[11px] text-ink-3">{hint}</span>}
    </>
  );
}

/**
 * A hover card over the track: drawn over everything (so that nothing cuts it off), its bottom edge at `y`
 * and its arrow pointing down at `x`, kept inside `bounds` and the window. It never takes the pointer, and it
 * rises into place unless motion is reduced. `width`: what it holds, without its padding.
 */
export function PeekCard({ x, y, width, bounds, label, children }: {
  x: number;
  y: number;
  width: number;
  /** The left and right edges it stays between, in viewport pixels (the editor's). */
  bounds?: { left: number; right: number };
  label: string;
  children: ReactNode;
}) {
  const outer = width + PEEK.chrome * 2;
  const lo = Math.max(PEEK.margin, (bounds?.left ?? 0) + PEEK.margin);
  const hi = Math.min(window.innerWidth - PEEK.margin, (bounds?.right ?? window.innerWidth) - PEEK.margin);
  const { left, arrow } = placeCard(x, outer, lo, hi);
  return createPortal(
    <div
      role="tooltip"
      aria-label={label}
      className="pointer-events-none fixed z-[70] rounded-[14px] border border-line-strong bg-panel p-2 text-ink shadow-[0_24px_60px_color-mix(in_oklab,var(--color-shade)_55%,transparent)] motion-safe:animate-[peek-rise_100ms_ease-out] motion-reduce:animate-[peek-fade_100ms_ease-out]"
      style={{ left, bottom: window.innerHeight - y, width: outer }}
    >
      {children}
      <span aria-hidden className="absolute -bottom-[7px] h-3 w-3 rotate-45 border-r border-b border-line-strong bg-panel" style={{ left: arrow - 6 }} />
    </div>,
    document.body,
  );
}
