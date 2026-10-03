import { secondsOf, type InputSpec } from "./inputs";
import { modelFileName } from "./warm";

/**
 * How long a render will take, guessed from the renders before it. The server keeps a record of each
 * render (its model, its settings, how long each part took); from those it makes, per recipe, what is
 * `Known`; and a guess for a form is read from that, here, by the server (the queue) and by the browser
 * (the button) alike: the two never say different things.
 */

/** Settings that change what is made, not how long it takes. */
const NO_TIME = /^(seed|crf|shift)/i;

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

/** What past renders of one recipe say. */
export interface Known {
  /** Renders with exactly these settings on this model: the best there is to go on. */
  settings: Array<{ key: string; model: string; ms: number; samples: number }>;
  /** Everything rendered with one model file. */
  models: Array<{ model: string; ms: number; perSecondMs: number | null; loadMs: number; samples: number }>;
  /** Everything rendered with the recipe, whatever the model. */
  ms: number;
  perSecondMs: number | null;
  /** What loading the model adds, when it is not loaded yet. */
  loadMs: number;
  samples: number;
}

export interface Guess {
  /** With the model already loaded. */
  ms: number;
  /** What a model that has to load first adds. */
  loadMs: number;
  /** What it rests on: the same settings, the same model, or only the same recipe. */
  from: "settings" | "model" | "recipe";
  samples: number;
}

/** About how long one render of these values takes; null when nothing like it was rendered yet. */
export function guess(known: Known | undefined, specs: InputSpec[], values: Record<string, unknown>): Guess | null {
  if (!known || !known.samples) return null;
  const model = modelOf(specs, values);
  const seconds = secondsOf(specs, values);
  const key = timeKey(specs, values);
  const ofModel = model ? known.models.find((m) => m.model === model) : undefined;
  const loadMs = ofModel?.loadMs ?? known.loadMs;
  // the same settings, on the same model when the form names one
  const same = known.settings.filter((s) => s.key === key && (!model || s.model === model)).sort((a, b) => b.samples - a.samples)[0];
  if (same) return { ms: same.ms, loadMs, from: "settings", samples: same.samples };
  const by = (per: number | null, flat: number) => Math.round(per && seconds ? per * seconds : flat);
  if (ofModel) return { ms: by(ofModel.perSecondMs, ofModel.ms), loadMs, from: "model", samples: ofModel.samples };
  return { ms: by(known.perSecondMs, known.ms), loadMs, from: "recipe", samples: known.samples };
}
