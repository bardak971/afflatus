import { regionsFor, type InputSpec } from "./inputs";

/**
 * What a form keeps when the operation changes (txt2img to inpaint, on the same model): what the user
 * set in the form they leave, for the inputs both forms have under the same name and of the same
 * kind. A setting whose starting value differs between the two (the denoising strength of img2img
 * and of inpaint) is each operation's own and stays behind. What the new form already holds is kept. The server
 * carries a clip's inputs the same way when a recording dropped on it makes it Lip sync (TimelineRecording.recordingClipsIn).
 */
export function carryOver(from: { inputs: InputSpec[] }, to: { inputs: InputSpec[] }, stored: Record<string, unknown> | undefined, held: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const i of to.inputs) {
    const value = stored?.[i.id];
    const was = from.inputs.find((o) => o.id === i.id);
    if (value === undefined || !was || was.type !== i.type || held?.[i.id] !== undefined) continue;
    switch (i.type) {
      case "prompt":
        if (was.type === "prompt" && was.style === i.style) out[i.id] = value;
        break;
      case "number":
        // a number's "auto" 0 sits below its range and is kept as it is
        if (was.type === "number" && was.default === i.default && typeof value === "number") out[i.id] = i.auto && value === 0 ? 0 : Math.min(i.max, Math.max(i.min, value));
        break;
      case "toggle":
        if (was.type === "toggle" && was.default === i.default) out[i.id] = value;
        break;
      case "choice":
        if (was.type === "choice" && JSON.stringify(was.options) === JSON.stringify(i.options)) out[i.id] = value;
        break;
      case "size": {
        const size = value as { width: number; height: number };
        if (was.type === "size" && Boolean(was.ratioOnly) === Boolean(i.ratioOnly) && was.grid === i.grid && Math.min(size.width, size.height) >= i.min && Math.max(size.width, size.height) <= i.max) out[i.id] = value;
        break;
      }
      case "image":
        if (was.type === "image" && was.role === i.role) out[i.id] = value;
        break;
      case "loras":
        out[i.id] = (value as unknown[]).slice(0, i.max);
        break;
      case "references": {
        const fits = (value as Array<{ role: string }>).filter((r) => (i.roles as string[]).includes(r.role)).slice(0, i.max);
        if (fits.length) out[i.id] = fits;
        break;
      }
      case "model":
      case "seed":
      case "audio":
        out[i.id] = value;
        break;
      case "cues":
        out[i.id] = (value as unknown[]).slice(0, i.max);
        break;
      case "regions":
        out[i.id] = regionsFor(i, value);
        break;
      // a clip to continue belongs to a timeline, not to a form that is carried along
      case "clip":
        break;
    }
  }
  return out;
}

/**
 * What goes along to another model's form: what the thing is made from and about. Its pictures, each
 * to the place that is for the same thing there (a start image to the start image, whatever the two
 * forms call it), and what is written, when both models are written to the same way. Never how the
 * first model was run: its file, its LoRAs and its settings are its own. Nothing the other form
 * already holds is replaced.
 */
export function carryAcross(from: { inputs: readonly InputSpec[] }, to: { inputs: readonly InputSpec[] }, stored: Record<string, unknown> | undefined, held: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!stored) return out;
  const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
  for (const i of to.inputs) {
    if (i.type !== "image" || !empty(held?.[i.id])) continue;
    const was = from.inputs.find((o) => o.type === "image" && o.role === i.role);
    if (was && !empty(stored[was.id])) out[i.id] = stored[was.id];
  }
  const said = (r: { inputs: readonly InputSpec[] }) => r.inputs.find((i) => i.type === "prompt" && !i.optional);
  const a = said(from);
  const b = said(to);
  if (a?.type === "prompt" && b?.type === "prompt" && a.style === b.style && !empty(stored[a.id]) && empty(held?.[b.id])) out[b.id] = stored[a.id];
  // the boxes drawn on the Stage (card #271), as the other model takes them: a text box only where boxes have kinds (MOSS),
  // a LoRA only where a region takes one; never over boxes the other form holds already
  const regionsTo = to.inputs.find((i) => i.type === "regions");
  const regionsWere = from.inputs.find((i) => i.type === "regions");
  if (regionsTo?.type === "regions" && regionsWere && Array.isArray(stored[regionsWere.id]) && !(held?.[regionsTo.id] as unknown[] | undefined)?.length) {
    const carried = regionsFor(regionsTo, stored[regionsWere.id]);
    if (carried.length) out[regionsTo.id] = carried;
  }
  return out;
}
