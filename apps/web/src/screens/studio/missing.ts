import type { RecipeInfo } from "../../api";

/**
 * Why Generate waits: an input the recipe cannot do without is still empty. A text with nothing to fall back on (H3's
 * What happens, an imported workflow's prompt shown as an example), a picture to work on (img2img, a fix), a mask not
 * painted yet (Inpaint), a video or a sound; the first one missing is named, in the words the timeline's clip inspector
 * uses (useClipEdits ready). One the recipe can do without (optional) never holds it back. ComfyUI is not asked: the
 * server would refuse the job for it all the same.
 */
export function inputMissing(recipe: RecipeInfo | undefined, whole: Record<string, unknown>): string | null {
  const missing = recipe?.inputs.find((i) =>
    i.type === "prompt" ? ((!i.optional && i.default === undefined) || i.example) && !String(whole[i.id] ?? "").trim()
    : (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional && !whole[i.id]);
  if (!missing) return null;
  const what = missing.label.toLowerCase();
  if (missing.type === "prompt") return `Write ${what} first.`;
  return missing.type === "image" && missing.role === "mask" ? `Paint the ${what} first (Inputs).` : `Add the ${what} first (Inputs).`;
}
