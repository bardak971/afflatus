import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Keys } from "./Keys";
import { parseKeys } from "./keys/grammar";

/**
 * The one tooltip of the app, in place of the browser's white `title` ones. Anything with a `data-tip`
 * attribute has it: one listener on the document reads the attribute of what the pointer rests on, so a
 * button only says what its tip is (`data-tip="Zoom in"`), and hundreds of them cost nothing.
 *
 * - `data-tip-keys="Ctrl+Z"`: keys drawn as keycaps after the text, in the grammar of `keys/grammar.ts`
 *   ("Ctrl+Shift+Z | Ctrl+Y", "← →"). A text that ends in keys in brackets ("Close (Esc)", "Undo (Ctrl+Z)",
 *   "Back (Tab or Esc)") has them drawn as keycaps too.
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

/**
 * "Close (Esc)" → "Close" and its keys; "Back (Tab or Esc)" → "Back" and "Tab or Esc". Null when the brackets do not
 * hold keys in the grammar ("(i2v)", "(Shift: ten)"), or hold a mouse move or code: those are words.
 */
export function trailingKeys(text: string): { text: string; keys: string } | null {
  const m = /^(.*\S)\s+\(([^()]+)\)$/s.exec(text);
  if (!m) return null;
  const parsed = parseKeys(m[2]!);
  if (!parsed || "code" in parsed || parsed.ways.some((w) => w.mouse)) return null;
  return { text: m[1]!, keys: m[2]!.trim() };
}

/** What a tip says, read from the element: a bold head (or none), the text, the keys. */
function readTip(el: HTMLElement): { head?: string; text: string; keys: string } {
  let text = el.dataset.tip ?? "";
  let head = el.dataset.tipHead;
  let keys = el.dataset.tipKeys?.trim() ?? "";
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

type Shown = { el: HTMLElement; head?: string; text: string; keys: string; at: { x: number; y: number }; fresh: boolean };

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
    // where the pointer was when a tip was shown for a keyboard focus: the tip stays while the keys are used, and goes once
    // the pointer moves off that spot (the hand back on the mouse), even over nothing that has a tip of its own. Before,
    // a focused status-bar "?" kept its tip standing over the inspector until the pointer crossed into another element.
    let keyedAt: { x: number; y: number } | null = null;

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
      keyedAt = null;
      aim(el);
    };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (keyedAt && showing && Math.hypot(e.clientX - keyedAt.x, e.clientY - keyedAt.y) > 8) {
        keyedAt = null;
        current = null;
        hide();
      }
    };
    const onOut = (e: PointerEvent) => {
      // out of the window (pointerover sees every other move)
      if (!e.relatedTarget) {
        current = null;
        quiet = null;
        hide();
      }
    };
    // the last key pressed moved the focus on purpose (Tab, the arrows): a focus given back by Esc, as a popover
    // closes, is not one the person went to, and its tip would open by itself and stay until the mouse moved
    let stepped = false;
    const press = () => {
      quiet = current;
      hide();
      warmUntil = 0;
    };
    // a press of the pointer: a Tab pressed before it (inside the keyboard sheet, then closed by its ×) no longer makes
    // the focus given back a keyboard one, whose tip would stand where the pointer is not (review 4)
    const pointerPress = () => {
      stepped = false;
      press();
    };
    const onKey = (e: KeyboardEvent) => {
      // a modifier alone is not typing; every other key sends the tip away (a Tab then shows the next one's, on focus)
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      stepped = e.key === "Tab" || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End";
      press();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipped(e.target);
      // only a focus from the keyboard: a click focuses too, and was just pressed
      if (el && el.matches(":focus-visible") && stepped) {
        quiet = null;
        current = null;
        keyedAt = { x: pointer.x, y: pointer.y };
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
    document.addEventListener("pointerdown", pointerPress, true);
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
      document.removeEventListener("pointerdown", pointerPress, true);
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
  const caps = keys.length > 0 && <Keys keys={keys} className="ml-auto pl-1" />;
  const long = (head ?? "").length + text.length > 48 || text.includes("\n");
  return createPortal(
    <div
      ref={box}
      id="app-tip"
      role="tooltip"
      style={{ visibility: "hidden", left: 0, top: 0 }}
      className={`pointer-events-none fixed z-tip rounded-xl border border-line-strong bg-raised px-3 py-2 text-left text-body leading-[1.45] font-normal tracking-normal text-ink normal-case shadow-[0_12px_30px_color-mix(in_srgb,var(--color-shade)_45%,transparent)] select-none ${long ? "w-max max-w-[300px] whitespace-pre-line" : "w-max whitespace-nowrap"} ${fresh ? "motion-safe:animate-tip-in motion-reduce:animate-peek-fade" : ""}`}
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
