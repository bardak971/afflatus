import type { TransitionKind } from "@afflatus/core";

/**
 * How each transition looks on the track and in the player. A swatch: two colours standing for the clips, the clip before
 * on the left. The player's keyframes: over the whole transition (offset 0.5 is the cut), on the clip before (`from`), the
 * clip after (`to`) and a veil over both, as the export's xfade draws it (core transitions.ts, server cut.ts).
 */

const A = "#b06a3c";
const B = "#4a76a8";

export const SWATCH: Record<TransitionKind, string> = {
  dissolve: `linear-gradient(90deg, ${A}, ${B})`,
  "dip-black": `linear-gradient(90deg, ${A}, #000 50%, ${B})`,
  "dip-white": `linear-gradient(90deg, ${A}, #fff 50%, ${B})`,
  flash: `linear-gradient(90deg, ${A} 40%, #fff 47%, #fff 53%, ${B} 60%)`,
  "wipe-left": `linear-gradient(90deg, ${A} 50%, ${B} 50%)`,
  "wipe-right": `linear-gradient(90deg, ${B} 50%, ${A} 50%)`,
  "slide-left": `linear-gradient(90deg, ${A} 35%, #222 35%, #222 40%, ${B} 40%)`,
  "slide-right": `linear-gradient(90deg, ${B} 60%, #222 60%, #222 65%, ${A} 65%)`,
  circle: `radial-gradient(circle at 50% 50%, ${B} 30%, ${A} 32%)`,
  zoom: `radial-gradient(circle at 50% 50%, ${B} 10%, ${A} 70%)`,
};

/** A step at the cut: hidden until it, shown from it. */
const fromCut: Keyframe[] = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.5 }, { opacity: 1, offset: 1 }];
/** Shown all through (a clip that a class would hide meanwhile: the one before, once the clip after has taken over). */
const shown: Keyframe[] = [{ opacity: 1 }, { opacity: 1 }];

export interface TransitionFrames {
  from?: Keyframe[];
  to?: Keyframe[];
  veil?: { colour: string; blend?: "plus-lighter"; frames: Keyframe[] };
}

export const PLAYER_FRAMES: Record<TransitionKind, TransitionFrames> = {
  dissolve: { from: shown, to: [{ opacity: 0 }, { opacity: 1 }] },
  "dip-black": { to: fromCut, veil: { colour: "#000", frames: [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }] } },
  "dip-white": { to: fromCut, veil: { colour: "#fff", frames: [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }] } },
  // white added on top (as the export's expression adds to the luma), not laid over: the picture blows out
  flash: { to: fromCut, veil: { colour: "#fff", blend: "plus-lighter", frames: [{ opacity: 0 }, { opacity: 0.86 }, { opacity: 0 }] } },
  "wipe-left": { from: shown, to: [{ opacity: 1, clipPath: "inset(0 0 0 100%)" }, { opacity: 1, clipPath: "inset(0 0 0 0%)" }] },
  "wipe-right": { from: shown, to: [{ opacity: 1, clipPath: "inset(0 100% 0 0)" }, { opacity: 1, clipPath: "inset(0 0% 0 0)" }] },
  "slide-left": { from: [{ opacity: 1, transform: "translateX(0)" }, { opacity: 1, transform: "translateX(-100%)" }], to: [{ opacity: 1, transform: "translateX(100%)" }, { opacity: 1, transform: "translateX(0)" }] },
  "slide-right": { from: [{ opacity: 1, transform: "translateX(0)" }, { opacity: 1, transform: "translateX(100%)" }], to: [{ opacity: 1, transform: "translateX(-100%)" }, { opacity: 1, transform: "translateX(0)" }] },
  circle: { from: shown, to: [{ opacity: 1, clipPath: "circle(0% at 50% 50%)" }, { opacity: 1, clipPath: "circle(71% at 50% 50%)" }] },
  // xfade's zoomin: the clip before zooms in over the first half, the clip after fades in over the second
  zoom: {
    from: [{ opacity: 1, transform: "scale(1)", offset: 0 }, { opacity: 1, transform: "scale(1.8)", offset: 0.5 }, { opacity: 1, transform: "scale(1.8)", offset: 1 }],
    to: [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 1 }],
  },
};
