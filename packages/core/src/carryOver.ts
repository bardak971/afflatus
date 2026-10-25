import type { InputSpec } from "./inputs";

/**
 * What a form keeps when the operation changes (txt2img to inpaint, on the same model): what the user
 * set in the form they leave, for the inputs both forms have under the same name and of the same
 * kind. A setting whose starting value differs between the two (the denoising strength of img2img
 * and of inpaint) is each operation's own and stays behind. What the new form already holds is kept. The server
 * carries a clip's inputs the same way when a recording dropped on it makes it Lip sync (Timelines.recordingClipsIn).
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
      // a clip to continue belongs to a timeline, not to a form that is carried along
      case "clip":
        break;
    }
  }
  return out;
}
