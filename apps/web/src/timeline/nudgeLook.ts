/**
 * How the player shows a clip's colour nudge at a join (the export's lutyuv, Player's colour matrix), where the browser can.
 *
 * Safari draws no SVG filter on a video: a `filter: url(#…)` on one is ignored, as on anything it composites (WebKit bug
 * 184601, open since 2018), so the nudge was never seen there. CSS's own filter functions are drawn on a video everywhere,
 * but have no offset of their own: a contrast and a brightness, one after the other, make one, the same for the three
 * channels. That is the nudge's light (luma) exactly; its tint, a different offset for each channel, has no such pair and is
 * left out there.
 */

/**
 * Whether this browser draws an SVG filter on a video. Told by the engine, not by a feature test: the filter is taken and
 * kept by Safari (CSS.supports says yes) and only its drawing leaves it out, which the page cannot read back (a canvas
 * draws the video without its CSS). Every browser on WebKit (Safari, and any browser on an iPhone) says AppleWebKit and no
 * Chrome; Chrome, Edge and Opera say both.
 */
export function svgFiltersOnVideo(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return !/AppleWebKit/.test(ua) || /Chrome\//.test(ua);
}

/**
 * The nudge's light, `y` steps of 255 added to every channel, as CSS filter functions: a contrast `c` around the middle and a
 * brightness `b`, with `b·c = 1` so that only the offset is left. Each step's result is kept between 0 and 1, so the order
 * is picked to keep the first one inside: up, the contrast first (it narrows), then the brightness; down, the brightness
 * first (it darkens), then the contrast. "" for none.
 */
export function lightFilter(y: number): string {
  const d = y / 255;
  if (!d) return "";
  const k = (n: number) => Number(n.toFixed(5));
  return d > 0 ? `contrast(${k(1 / (1 + 2 * d))}) brightness(${k(1 + 2 * d)})` : `brightness(${k(1 / (1 - 2 * d))}) contrast(${k(1 - 2 * d)})`;
}
