/**
 * A form's row moved off its value, its conditions met: shared by the test that every row reaches the graph
 * (inputsReachGraph.test.ts) and the golden graph dump (scripts/golden-graphs.ts), so that both move a row the same way.
 */
import type { InputSpec, Recipe } from "@afflatus/core";

type Values = Record<string, unknown>;
type Variant = Recipe<any>["variants"][number];

/** The optional files a finish route needs, given to every variant: its settings then have the route to act on. */
export const EXTRA_FILES = { seedvr: "seedvr2_3b.safetensors", seedvrVae: "seedvr2_vae.safetensors", latentUpscaler: "minimax_h3_latent_upscaler.safetensors" };

/** Another value than `now` for an input, one the form could hold. */
export function other(spec: InputSpec, now: unknown): unknown[] {
  switch (spec.type) {
    case "number": {
      const n = typeof now === "number" ? now : spec.default;
      return [spec.max, spec.min, (spec.min + spec.max) / 2].map((v) => Math.round(v / spec.step) * spec.step).filter((v) => v !== n && v >= spec.min && v <= spec.max);
    }
    case "toggle":
      return [!now];
    case "choice":
      return Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options].filter((o) => o !== now) : ["zz-other.pth"].filter((o) => o !== now);
    default:
      return [];
  }
}

/** The values with `spec`'s conditions met (a switch on, a choice picked, a picture given), and what the build is handed for them. */
export function shown(r: Recipe<any>, spec: InputSpec, v: Variant): { input: Values; uploads: Record<string, string>; media: Record<string, unknown> } | null {
  const input: Values = { ...(v.input as Values) };
  const uploads = { ...v.uploads };
  const media: Record<string, unknown> = { ...v.media };
  let at: InputSpec | undefined = spec;
  for (let guard = 0; at?.showWhen && guard < 8; guard++) {
    const w: NonNullable<InputSpec["showWhen"]> = at.showWhen;
    const id: string = typeof w === "string" ? w : w.input;
    const parent: InputSpec | undefined = r.inputs.find((i) => i.id === id);
    if (!parent) return null;
    if (typeof w !== "string") input[id] = w.in[0];
    else if (parent.type === "toggle") input[id] = true;
    else if (parent.type === "image") {
      input[id] ??= "p";
      uploads[id] ??= `${id}.png`;
      media[id] ??= { width: 832, height: 1216 };
    } else if (!input[id]) return null;
    at = parent;
  }
  return { input, uploads, media };
}
