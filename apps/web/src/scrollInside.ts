/**
 * Bring `el` into view in the box that scrolls around it, and only there. The browser's scrollIntoView moves every
 * box around it, the page itself included: the whole app slid up out of the window when a form's part was shown.
 * The part's scroll-margin (under a sticky head) is kept.
 */
export function scrollInside(el: Element | null | undefined, block: "start" | "center" = "start") {
  if (!(el instanceof HTMLElement)) return;
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return;
  const at = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const top = block === "center" ? at - (box.clientHeight - el.offsetHeight) / 2 : at - margin;
  box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}
