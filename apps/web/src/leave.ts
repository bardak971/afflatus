import { useCallback, type RefObject } from "react";
import { OUT_MS } from "./motion";

/**
 * The exit of what its parent takes away at once (`{open && <Dialog …/>}`): most overlays of the app are drawn that
 * way, and keeping each one mounted for its exit would mean an open prop in every user. Instead, when React takes the
 * element away, a still copy of it is put where it was and plays the exit (motion.ts's classes), then goes. The copy is
 * inert, hidden from screen readers, has no role, id nor data-* left (the app's checks for an open dialog, menu or
 * floating panel do not see it) and takes no pointer: the real one is gone at once, its keys, its focus trap and its
 * focus with it, so nothing waits for the animation. Only for an element positioned out of the flow (fixed or
 * absolute): the copy is added at the end of the same parent and must land in the same place.
 */

/** A page that draws (not the tests' jsdom, whose queries would find the copy), and motion wanted. */
export const moves = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  !/jsdom/i.test(navigator.userAgent) &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The classes that would play an opening again on the copy. */
const OPENING = /(^|:)animate-|^m-(pop|pop-out|toast|panel|fade|out|shake|ok)$/;
/** What would make the copy count as the real thing (a dialog, a menu, a floating panel, a field of a form). */
const NAMED = new Set(["id", "role", "aria-modal", "aria-activedescendant", "autofocus", "name", "for"]);

/** A canvas or a video as a picture of what it shows now: a copied canvas is blank, a copied video would load again. */
function still(media: HTMLCanvasElement | HTMLVideoElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = media.className;
  c.style.cssText = media.style.cssText;
  const video = media instanceof HTMLVideoElement;
  c.width = (video ? media.videoWidth : media.width) || 1;
  c.height = (video ? media.videoHeight : media.height) || 1;
  try {
    c.getContext("2d")?.drawImage(media, 0, 0, c.width, c.height);
  } catch {
    // a frame that cannot be read (not loaded yet) leaves the copy empty for its few milliseconds
  }
  return c;
}

/**
 * Called while `el` is still on the page, just before React removes it: the copy is made now (scroll positions and
 * pictures are only readable now) and put in place once the removal is done. An element still on the page by then was
 * not taken away (StrictMode's trial unmount, a Suspense that hides it): no copy.
 */
export function leaveCopy(el: HTMLElement, exit: string): void {
  const parent = el.parentNode;
  if (!parent || !moves()) return;
  const copy = el.cloneNode(true) as HTMLElement;
  const from = [el, ...el.querySelectorAll<HTMLElement>("*")];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  const scrolled: Array<[HTMLElement, number, number]> = [];
  from.forEach((a, i) => {
    const b = to[i];
    if (!b) return;
    for (const t of [...b.classList]) if (OPENING.test(t)) b.classList.remove(t);
    for (const n of b.getAttributeNames()) if (NAMED.has(n) || n.startsWith("data-")) b.removeAttribute(n);
    if (a.scrollTop || a.scrollLeft) scrolled.push([b, a.scrollTop, a.scrollLeft]);
    if (a instanceof HTMLCanvasElement || a instanceof HTMLVideoElement) b.replaceWith(still(a));
    else if (a instanceof HTMLAudioElement) b.remove();
    else if ((a instanceof HTMLInputElement && a.type !== "file") || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) {
      // what was typed lives in the property, which a copy does not take
      (b as typeof a).value = a.value;
      if (a instanceof HTMLInputElement) (b as HTMLInputElement).checked = a.checked;
    }
  });
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.style.pointerEvents = "none";
  copy.classList.add(exit);
  queueMicrotask(() => {
    if (el.isConnected || !(parent as Node).isConnected) return;
    parent.appendChild(copy);
    for (const [b, top, left] of scrolled) {
      b.scrollTop = top;
      b.scrollLeft = left;
    }
    // a little past the exit's length, so that its last frame (fully faded, kept by "forwards") is the one taken away
    setTimeout(() => copy.remove(), OUT_MS + 25);
  });
}

/**
 * A ref for the element that should play `exit` when it is taken away. `own`: the component's own ref to the element,
 * kept up to date. The callback is stable, so React calls it only when the element comes and goes.
 */
export function useLeave<T extends HTMLElement>(exit: string, own?: RefObject<T | null>) {
  return useCallback((el: T | null) => {
    if (own) own.current = el;
    if (!el) return;
    return () => {
      if (own) own.current = null;
      leaveCopy(el, exit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
