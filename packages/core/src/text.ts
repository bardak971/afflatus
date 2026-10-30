/**
 * A text made a slug for a file name, an id or a typed word: lower case, its accents folded ("Crème brûlée" →
 * "creme-brulee"), every run of other signs one dash, no dash at either end, at most `max` characters. A text with
 * nothing left (only signs, or another script: "夜の街") gives "": the caller says what stands in for it.
 */
export const slug = (text: string, max = Infinity) =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** A text with only its letters and digits, lower case: "Krea 2" and "krea2" one name, "Qwen-Image" "qwenimage". */
export const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A count with its word: "1 take", "3 settings", "2 people" (`many` for a word that does not just take an s). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The verb that goes with a count, without the count: verb(n, "is", "are"), verb(n, "takes", "take"). */
export const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A GPU's name made short, the one way every screen says it: "RTX 4070 Ti" from ComfyUI's "cuda:0 NVIDIA GeForce RTX
 * 4070 Ti : cudaMallocAsync" and RunPod's "NVIDIA GeForce RTX 4070 Ti", "RTX 6000 Ada" from "NVIDIA RTX 6000 Ada
 * Generation". Seven places cut it three ways, and the same card was named two ways.
 */
export const shortGpu = (name: string): string =>
  name.replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*\S+\s*$/, "").replace(/\b(NVIDIA|GeForce)\s+/g, "").replace(/\s+Generation$/, "").trim() || name;
