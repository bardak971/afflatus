import type { RecipeInfo } from "./api";

/**
 * What a form keeps when the operation changes (txt2img to inpaint, on the same model): what the user
 * set in the form they leave, for the inputs both forms have under the same name and of the same
 * kind. A setting whose starting value differs between the two (the denoising strength of img2img
 * and of inpaint) is each operation's own and stays behind. What the new form already holds is kept.
 */
export function carryOver(from: RecipeInfo, to: RecipeInfo, stored: Record<string, unknown> | undefined, held: Record<string, unknown> | undefined): Record<string, unknown> {
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
        if (was.type === "number" && was.default === i.default && typeof value === "number") out[i.id] = Math.min(i.max, Math.max(i.min, value));
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
      // a clip to continue belongs to a timeline, not to a form that is carried along
      case "clip":
        break;
    }
  }
  return out;
}

/** A model to make things with: a built-in family, the workflows imported under its name, or both. */
export interface ModelGroup {
  key: string;
  name: string;
  summary: string;
  /** Built in, as opposed to made only of imported workflows. */
  builtIn: boolean;
  /** Its operations: the built-in ones, then the user's workflows. */
  recipes: RecipeInfo[];
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The models, each with its operations. A workflow imported under the name of a built-in model
 * ("Krea2" and "Krea 2" are one name) is listed with that model, next to its built-in operations.
 */
export function modelGroups(recipes: RecipeInfo[], families: Array<{ id: string; name: string; summary: string }>): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const family of families) {
    const own = recipes.filter((r) => r.family === family.id);
    if (!own.length) continue;
    const builtIn = !family.id.startsWith("workflow-");
    const same = groups.find((g) => g.key === squash(family.name));
    if (same) {
      same.recipes.push(...own);
      if (builtIn && !same.builtIn) Object.assign(same, { name: family.name, summary: family.summary, builtIn: true, recipes: [...own, ...same.recipes.filter((r) => !own.includes(r))] });
    } else {
      groups.push({ key: squash(family.name), name: family.name, summary: family.summary, builtIn, recipes: own });
    }
  }
  // a recipe whose family is not listed is still something to make things with
  for (const r of recipes) {
    if (groups.some((g) => g.recipes.includes(r))) continue;
    const same = groups.find((g) => g.key === squash(r.family));
    if (same) same.recipes.push(r);
    else groups.push({ key: squash(r.family), name: r.family, summary: "", builtIn: false, recipes: [r] });
  }
  return groups;
}
