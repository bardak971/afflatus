import { create } from "zustand";
import type { InputSpec, ReferenceValue } from "@afflatus/core";
import type { Asset, RecipeInfo } from "./api";
import type { MenuItem } from "./ContextMenu";

/**
 * The form open in Studio, as the library's menus see it: its recipe, what it holds, and how to set one of its
 * inputs. The Create panel publishes it while it shows a form; a tile's menu reads it to offer "Use in this
 * draft", the same places a drop on the form reaches.
 */
interface Target {
  recipe: RecipeInfo;
  values: Record<string, unknown>;
  set(input: string, value: unknown): void;
}
export const useFormTarget = create<{ target: Target | null; publish(t: Target | null): void }>((set) => ({
  target: null,
  publish: (target) => set({ target }),
}));

const ROLE_WORDS: Record<string, string> = { source: "Source image", start: "First frame", end: "Last frame", mid: "Keyframe", mask: "Mask" };

/** Where a library item can go in the open form: one line per input that takes it, in the form's order. */
export function formPlaces(target: Target | null, a: Asset): MenuItem[] {
  if (!target || a.inBin) return [];
  const { recipe, values, set } = target;
  const filled = (id: string) => values[id] !== undefined && values[id] !== null && values[id] !== "";
  const out: MenuItem[] = [];
  for (const i of recipe.inputs as InputSpec[]) {
    if (i.type === "image" && a.kind === "image") {
      out.push({ label: i.label || ROLE_WORDS[i.role] || "Image", note: filled(i.id) ? "replaces the one there" : undefined, run: () => set(i.id, a.id) });
    } else if (i.type === "clip" && a.kind === "video") {
      out.push({ label: i.label || (i.role === "previous" ? "Previous clip" : "Next clip"), note: filled(i.id) ? "replaces the one there" : i.role === "previous" ? "carries on from its end" : "arrives at its start", run: () => set(i.id, { asset: a.id }) });
    } else if (i.type === "references" && ((i.media === "video" && a.kind === "video") || (i.media !== "video" && a.kind === "image"))) {
      const list = (values[i.id] as ReferenceValue[] | undefined) ?? [];
      const has = list.some((x) => x.asset === a.id);
      out.push({ label: i.label || (i.media === "video" ? "Reference video" : "Reference image"), note: has ? "already there" : `${list.length} of ${i.max}`, disabled: has || list.length >= i.max, run: () => set(i.id, [...list, { asset: a.id, role: i.roles[0]! }]) });
    } else if (i.type === "audio" && (a.kind === "audio" || (a.kind === "video" && a.hasSound))) {
      out.push({ label: i.label || (i.role === "voice" ? "Voice sample" : "Sound"), note: a.kind === "video" ? "its sound" : filled(i.id) ? "replaces the one there" : undefined, run: () => set(i.id, a.id) });
    }
  }
  return out;
}
