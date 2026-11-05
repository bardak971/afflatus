/**
 * How the mask is shown over the picture (owner's picks on mock-0.10-paint-look, 2026-11-05). The eye (M) cycles four
 * views: Tint (the accent at 40 %, fading across the feather, a thin bright edge with a soft glow where the mask is half),
 * Spotlight (the rest darkened, what will change at full brightness), B&W (the mask as it is sent, grey levels and all) and
 * Off. Display only: the canvas holds the mask's own levels as alpha, and an SVG filter per view draws them; the PNG sent to
 * ComfyUI is made from the plane, never from what is shown.
 */

export type MaskView = "tint" | "spot" | "bw" | "off";

/** The eye's order, from the view a mask opens on: each press shows the next. */
export const MASK_VIEWS: readonly MaskView[] = ["tint", "spot", "bw", "off"];

export const MASK_VIEW_NAMES: Record<MaskView, string> = { tint: "Tint", spot: "Spotlight", bw: "B&W", off: "Off" };

export const nextView = (v: MaskView): MaskView => MASK_VIEWS[(MASK_VIEWS.indexOf(v) + 1) % MASK_VIEWS.length]!;

/** How long a fresh stroke takes to fade in, and a view to cross-fade: short enough never to lag the hand. */
export const FADE_MS = 200;

/** How much of the picture the mask's tint covers it with, at full strength (30 % barely showed on skin). */
const TINT = 0.4;
/** How dark Spotlight makes what is left alone. */
const SPOT_DARK = 0.66;
/** The bright edge, in screen pixels whatever the zoom: its width, and its glow's spread in the Tint view. */
const EDGE_PX = 1.5;
const GLOW_PX = 4;

/** The edge colour: the accent taken most of the way to white, so it reads on the tint and on the picture alike. */
const EDGE = "color-mix(in srgb, var(--color-accent) 35%, white)";

/** A view's filter, as the canvas's CSS `filter` (none for Off: the canvas is hidden). */
export const viewFilter = (id: string, view: MaskView) => (view === "off" ? undefined : `url(#${id}-${view})`);

/**
 * The views' SVG filters, for one canvas whose own pixels are the mask's levels as alpha. `scale`: the zoom the canvas is
 * drawn at (its box is scaled), so that the edge stays so many screen pixels wide. Each filter keeps to the canvas's own
 * box: Spotlight's darkening ends at the picture's edge.
 */
export function MaskFilters({ id, scale }: { id: string; scale: number }) {
  const k = 1 / Math.max(0.01, scale);
  /** The edge: the mask cut at half (where the feather is half way), less itself eroded by the edge's width. */
  const edge = (out: string) => (
    <>
      <feComponentTransfer in="SourceAlpha" result="solid">
        <feFuncA type="discrete" tableValues="0 1" />
      </feComponentTransfer>
      <feMorphology in="solid" operator="erode" radius={EDGE_PX * k} result="inner" />
      <feComposite in="solid" in2="inner" operator="out" result="ring" />
      <feFlood style={{ floodColor: EDGE }} />
      <feComposite in2="ring" operator="in" result={out} />
    </>
  );
  const box = { x: "0", y: "0", width: "100%", height: "100%", colorInterpolationFilters: "sRGB" } as const;
  return (
    <svg aria-hidden width="0" height="0" className="pointer-events-none absolute">
      <defs>
        <filter id={`${id}-tint`} {...box}>
          <feFlood style={{ floodColor: "var(--color-accent)", floodOpacity: TINT }} />
          <feComposite in2="SourceAlpha" operator="in" result="fill" />
          {edge("edge")}
          <feGaussianBlur in="edge" stdDeviation={GLOW_PX * k} result="blur" />
          <feComponentTransfer in="blur" result="glow">
            <feFuncA type="linear" slope="1.6" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="fill" />
            <feMergeNode in="glow" />
            <feMergeNode in="edge" />
          </feMerge>
        </filter>
        <filter id={`${id}-spot`} {...box}>
          <feComponentTransfer in="SourceAlpha" result="outside">
            <feFuncA type="linear" slope={-SPOT_DARK} intercept={SPOT_DARK} />
          </feComponentTransfer>
          <feFlood floodColor="#000" />
          <feComposite in2="outside" operator="in" result="dark" />
          {edge("edge")}
          <feMerge>
            <feMergeNode in="dark" />
            <feMergeNode in="edge" />
          </feMerge>
        </filter>
        <filter id={`${id}-bw`} {...box}>
          <feFlood floodColor="#000" result="black" />
          <feFlood floodColor="#fff" />
          <feComposite in2="SourceAlpha" operator="in" result="white" />
          <feMerge>
            <feMergeNode in="black" />
            <feMergeNode in="white" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}
