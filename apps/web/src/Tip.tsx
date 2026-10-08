import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The one tooltip of the app, in place of the browser's white `title` ones. Anything with a `data-tip`
 * attribute has it: one listener on the document reads the attribute of what the pointer rests on, so a
 * button only says what its tip is (`data-tip="Zoom in"`), and hundreds of them cost nothing.
 *
 * - `data-tip-keys="Ctrl +"`: keys drawn as keycaps after the text, split on spaces. A text that ends in
 *   keys in brackets ("Close (Esc)", "Undo (Ctrl+Z)") has them drawn as keycaps too.
 * - `data-tip-head="Join"`: a bold first line, `data-tip` the dim line under it. A long text that starts
 *   with a few words and a colon ("Compare: pin this one…") is shown the same way.
 *
 * It shows once the pointer has rested a moment, then goes from one button to the next at once while
 * the pointer moves along a row of them; it never covers the pointer, stays on the screen, and goes as
 * soon as something is pressed, scrolled or typed. A `title` the code still has (a screen not converted
 * yet) is taken over the first time it is hovered, so the browser's own never shows.
 */

/** How long the pointer rests on something before its tip shows. */
const SHOW_AFTER_MS = 400;
/** For how long after a tip went the next one shows at once: moving along a row of buttons. */
const WARM_MS = 500;
/** Room kept between the tip, what it is about, and the edges of the window. */
const GAP = 8;
/** Bigger than this, what the tip is about is a panel or a tile: the tip goes by the pointer, not by it. */
const BIG_PX = 64;

/** The keys a text may end with in brackets: names of keys, and single capitals or signs. */
const KEY = /^(Esc|Tab|Enter|Space|Del|Delete|Backspace|Shift|Ctrl|Alt|Cmd|Home|End|PgUp|PgDn|F\d{1,2}|[A-Z]|[/?,.+\-[\]←→↑↓])$/;

/** "Close (Esc)" → "Close" and its keys; "Back (Tab or Esc)" → "Back", Tab, "or", Esc. Null when it does not end in keys. */
export function trailingKeys(text: string): { text: string; keys: string[] } | null {
  const m = /^(.*\S)\s+\(([^()]+)\)$/s.exec(text);
  if (!m) return null;
  const keys: string[] = [];
  for (const alt of m[2]!.split(" or ")) {
    const combo = alt.trim().split("+");
    // "Ctrl++" is Ctrl and the plus key
    const parts = combo.length > 2 && combo.at(-1) === "" ? [...combo.slice(0, -2), "+"] : combo;
    if (!parts.every((k) => KEY.test(k.trim()))) return null;
    if (keys.length) keys.push("or");
    keys.push(...parts.map((k) => k.trim()));
  }
  return { text: m[1]!, keys };
}

/** What a tip says, read from the element: a bold head (or none), the text, the keys. */
export function readTip(el: HTMLElement): { head?: string; text: string; keys: string[] } {
  let text = el.dataset.tip ?? "";
  let head = el.dataset.tipHead;
  let keys = el.dataset.tipKeys?.split(/\s+/).filter(Boolean) ?? [];
  // "Rename (F2): a name of your own…": a few words and a colon start a long text, they are its head
  const colon = text.indexOf(": ");
  if (!head && colon > 0 && colon <= 32 && text.length > 56 && text.slice(0, colon).split(" ").length <= 4) {
    head = text.slice(0, colon);
    const rest = text.slice(colon + 2);
    text = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  const short = trailingKeys(head ?? text);
  if (short && !keys.length) {
    keys = short.keys;
    if (head) head = short.text;
    else text = short.text;
  }
  return { head, text, keys };
}

/** A key, as a cap: the command bar's keycap, a step lighter, as it sits on a raised panel. */
function Cap({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-hover px-1.5 font-mono text-[11px] leading-none font-normal text-ink shadow-[inset_0_-1px_0_var(--color-line-strong)]">{children}</kbd>;
}

type Shown = { el: HTMLElement; head?: string; text: string; keys: string[]; at: { x: number; y: number }; fresh: boolean };

/** What the pointer or the focus is on that has a tip, taking over a `title` on the way. */
function tipped(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-tip], [title]:not(iframe, html, head, title)");
  if (!el) return null;
  if (el.hasAttribute("title")) {
    // a title left in the code: the app's tip in its place, the browser's never shows
    const t = el.getAttribute("title");
    el.removeAttribute("title");
    if (t && !el.dataset.tip) el.dataset.tip = t;
  }
  return el.dataset.tip ? el : null;
}

/** The tooltip, mounted once by the app. */
export function Tips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    let showing = false;
    let warmUntil = 0;
    // pressed or typed on: no tip for it again until the pointer has left it
    let quiet: HTMLElement | null = null;
    const pointer = { x: -1, y: -1 };

    const show = (el: HTMLElement, fresh: boolean) => {
      if (!el.isConnected || !el.dataset.tip) return;
      showing = true;
      setShown({ el, ...readTip(el), at: { ...pointer }, fresh });
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!showing) return;
      showing = false;
      warmUntil = performance.now() + WARM_MS;
      setShown(null);
    };
    const aim = (el: HTMLElement | null) => {
      if (el === current) return;
      current = el;
      if (!el || el === quiet) return hide();
      if (timer) clearTimeout(timer);
      timer = undefined;
      // one showing, or one gone a moment ago: the next at once, and without the rise
      if (showing || performance.now() < warmUntil) show(el, false);
      else timer = setTimeout(() => show(el, true), SHOW_AFTER_MS);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      const el = tipped(e.target);
      if (quiet && el !== quiet) quiet = null;
      aim(el);
    };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const onOut = (e: PointerEvent) => {
      // out of the window (pointerover sees every other move)
      if (!e.relatedTarget) {
        current = null;
        quiet = null;
        hide();
      }
    };
    const press = () => {
      quiet = current;
      hide();
      warmUntil = 0;
    };
    const onKey = (e: KeyboardEvent) => {
      // a modifier alone is not typing; every other key sends the tip away (a Tab then shows the next one's, on focus)
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      press();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipped(e.target);
      // only a focus from the keyboard: a click focuses too, and was just pressed
      if (el && el.matches(":focus-visible")) {
        quiet = null;
        current = null;
        pointer.x = -1;
        aim(el);
      }
    };
    const onBlur = (e: FocusEvent) => {
      if (e.target === current) {
        current = null;
        hide();
      }
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("blur", hide);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // what it is about is described by it while it shows (the `title` it replaces was a description too)
  useEffect(() => {
    const el = shown?.el;
    if (!el || el.hasAttribute("aria-describedby")) return;
    el.setAttribute("aria-describedby", "app-tip");
    return () => el.removeAttribute("aria-describedby");
  }, [shown?.el]);

  // where it goes: above what it is about (below when there is no room), kept on the screen
  useLayoutEffect(() => {
    const b = box.current;
    if (!shown || !b) return;
    const r = shown.el.getBoundingClientRect();
    const { x, y } = shown.at;
    // a panel or a tile: the tip goes by the pointer (left under its tip, the cursor's height below), not over the middle of it
    const big = (r.height > BIG_PX || r.width > BIG_PX * 5) && x >= 0;
    const a = big ? { left: x - 4, right: x + 4, top: y - 4, bottom: y + 22 } : r;
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const above = a.top - GAP - h >= GAP || vh - a.bottom < h + GAP * 2;
    const top = above ? Math.max(GAP, a.top - GAP - h) : Math.min(vh - h - GAP, a.bottom + GAP);
    const mid = (a.left + a.right) / 2;
    const left = Math.max(GAP, Math.min(vw - w - GAP, mid - w / 2));
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
    b.dataset.side = above ? "above" : "below";
    const p = arrow.current;
    if (p) {
      p.style.left = `${Math.max(10, Math.min(w - 10, mid - left)) - 5}px`;
      p.style.top = above ? "" : "-6px";
      p.style.bottom = above ? "-6px" : "";
      p.style.transform = above ? "rotate(45deg)" : "rotate(225deg)";
    }
    b.style.visibility = "visible";
  }, [shown]);

  if (!shown) return null;
  const { head, text, keys, fresh } = shown;
  const caps = keys.length > 0 && (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
      {keys.map((k, i) => (k === "or" ? <span key={i} className="text-[11px] text-ink-3">or</span> : <Cap key={i}>{k}</Cap>))}
    </span>
  );
  const long = (head ?? "").length + text.length > 48 || text.includes("\n");
  return createPortal(
    <div
      ref={box}
      id="app-tip"
      role="tooltip"
      style={{ visibility: "hidden", left: 0, top: 0 }}
      className={`pointer-events-none fixed z-[200] rounded-[9px] border border-line-strong bg-raised px-2.5 py-[7px] text-left text-[12.5px] leading-[1.45] font-normal tracking-normal text-ink normal-case shadow-[0_12px_30px_color-mix(in_srgb,var(--color-shade)_45%,transparent)] select-none ${long ? "w-max max-w-[300px] whitespace-pre-line" : "w-max whitespace-nowrap"} ${fresh ? "motion-safe:animate-[tip-in_110ms_ease-out] motion-reduce:animate-[peek-fade_100ms_ease-out]" : ""}`}
    >
      {head ? (
        <>
          <span className="flex items-center gap-2 font-bold">{head}{caps}</span>
          {text && <span className="block text-ink-2">{text}</span>}
        </>
      ) : (
        <span className="flex items-center gap-2">{text}{caps}</span>
      )}
      <span ref={arrow} aria-hidden className="absolute h-2.5 w-2.5 border-r border-b border-line-strong bg-raised" />
    </div>,
    document.body,
  );
}
