import type { InputSpec } from "./inputs";
import { modelFileName } from "./warm";

/**
 * What the record of render times files a render under (its time key, its model), and how an estimate is
 * said. The estimate itself is the server's (forecast.ts): the queue, the form and the Generate button all
 * ask it, so they never say different things.
 */

/**
 * Settings that change what is made, not how long it takes. Where a Motion transfer part starts in its driving video
 * (drivingStart) is one: with it in the key, every window of a timeline was filed under a key of its own, and no two
 * machines' renders of the same windows were ever compared (forecast.ts machinePaces).
 */
const NO_TIME = /^(seed|crf|drivingStart)$|^shift/i;
/**
 * Settings said in the key only when moved from their default. SeedVR2's frames together changes its render time
 * several-fold, but every video form holds it: said always, it would have changed the key of every video render and
 * left them without the times recorded before it was counted.
 */
const SAID_WHEN_SET = new Set(["seedvrFrames"]);

/**
 * What of a form decides how long its render takes: its numbers, its switches and its choices, its
 * size, and whether it was handed pictures, clips and sounds. Not its words, its seed or its files.
 * Two forms with the same key take the same time on the same model.
 */
export function timeKey(specs: InputSpec[], values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const spec of specs) {
    const value = values[spec.id];
    switch (spec.type) {
      case "number":
      case "toggle":
      case "choice":
        if (NO_TIME.test(spec.id)) break;
        if (SAID_WHEN_SET.has(spec.id) && (value ?? spec.default) === spec.default) break;
        parts.push(`${spec.id}=${String(value ?? spec.default)}`);
        break;
      case "size": {
        const shape = typeof value === "string" || value === undefined ? spec.shapes.find((s) => s.id === (value ?? spec.default)) : (value as { width: number; height: number });
        if (shape) parts.push(`${spec.id}=${shape.width}x${shape.height}`);
        break;
      }
      case "image":
      case "clip":
      case "audio":
        if (value) parts.push(`${spec.id}+`);
        break;
      case "references":
        if (Array.isArray(value) && value.length) parts.push(`${spec.id}=${value.length}`);
        break;
      default:
        break;
    }
  }
  return parts.join(";");
}

/** A model file as renders are filed under it: no folder, no extension, lower case. */
export const modelName = (file: string): string => modelFileName(file).replace(/\.[a-z0-9]+$/, "");

/** The model file a form names, as renders are filed under it: null when the form leaves it to the usual one. */
export function modelOf(specs: InputSpec[], values: Record<string, unknown>): string | null {
  const spec = specs.find((i) => i.type === "model");
  const value = spec && values[spec.id];
  return typeof value === "string" && value ? modelName(value) : null;
}

/**
 * A time an estimate says, rounded as one: "40 s" (to five seconds, never under five), "2 min" from a minute
 * and a half. The one rounding of every "about": the Generate button and the form's Output line say the same
 * figure for the same forecast because both are written with it.
 */
export function roughly(ms: number): string {
  const s = ms / 1000;
  return s < 90 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`;
}
