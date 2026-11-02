import { refusalOf, type ReferenceValue } from "@afflatus/core";
import type { RecipeInfo } from "../../api";

/**
 * Why Generate waits: an input the recipe cannot do without is still empty. A text with nothing to fall back on (H3's
 * What happens, an imported workflow's prompt shown as an example), a picture to work on (img2img, a fix), a mask not
 * painted yet (Inpaint), a video or a sound; the first one missing is named, in the words the timeline's clip inspector
 * uses (useClipEdits ready). One the recipe can do without (optional) never holds it back. Or a mix of inputs the recipe
 * refuses (Krea 2's person reference with style reference images, core's Recipe.refuses), in its words, the pictures the
 * cast adds when the form is sent counted in (`cast`, compose's: they go to the recipe's first reference input, Krea 2's
 * person reference): the server refused a cast person with style images, and Render was not greyed (card #237). ComfyUI is
 * not asked: the server would refuse the job for it all the same.
 */
export function inputMissing(recipe: RecipeInfo | undefined, form: Record<string, unknown>, cast: readonly ReferenceValue[] = []): string | null {
  const spec = recipe?.inputs.find((i) => i.type === "references" && !("media" in i && i.media));
  const own = spec && Array.isArray(form[spec.id]) ? (form[spec.id] as ReferenceValue[]) : [];
  const whole = spec && cast.length ? { ...form, [spec.id]: [...own, ...cast] } : form;
  const missing = recipe?.inputs.find((i) =>
    i.type === "prompt" ? ((!i.optional && i.default === undefined) || i.example) && !String(whole[i.id] ?? "").trim()
    : (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional && !whole[i.id]);
  if (!missing) return recipe ? refusalOf(recipe, whole) : null;
  const what = missing.label.toLowerCase();
  if (missing.type === "prompt") return `Write ${what} first.`;
  return missing.type === "image" && missing.role === "mask" ? `Paint the ${what} first (Inputs).` : `Add the ${what} first (Inputs).`;
}
