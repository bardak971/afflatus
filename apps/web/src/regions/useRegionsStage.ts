import { create } from "zustand";
import { useFormTarget } from "../formTarget";
import type { Size } from "../viewer/zoom";
import { regionsAbsent, regionList, regionsSpecOf, type Absent, type RegionsSpec, type RegionValue } from "./types";

/**
 * The regions as the Stage and the form share them: which one is selected (a box picked on the Stage lights its row up, a
 * row picked lights its box up), and whether the boxes are laid over the draft's finished picture for a re-render. An empty
 * draft shows them on its frame without being asked.
 */
interface RegionsStage {
  /** The region selected, by id; none. */
  selected: string | null;
  /** The draft whose Stage shows the boxes over its picture shown (a draft that has made something). */
  over: string | null;
  /** The tool picked on the Stage, kept while the Stage is drawn again (a render arriving). */
  tool: string;
  select(id: string | null): void;
  show(draft: string, tool?: string): void;
  leave(): void;
  setTool(tool: string): void;
}

export const useRegionsStage = create<RegionsStage>((set) => ({
  selected: null,
  over: null,
  tool: "box",
  select: (selected) => set({ selected }),
  show: (over, tool) => set((s) => ({ over, tool: tool ?? s.tool })),
  leave: () => set({ over: null }),
  setTool: (tool) => set({ tool }),
}));

/** The frame a txt2img draft draws, when its form says no size: the families' usual square. */
const SQUARE: Size = { w: 1024, h: 1024 };

/** The size the form asks for (its size input, as it stands with the defaults), or the usual square. */
export function formSize(inputs: ReadonlyArray<{ id: string; type: string }>, values: Record<string, unknown>): Size {
  const input = inputs.find((i) => i.type === "size");
  const v = input ? (values[input.id] as { width?: number; height?: number } | undefined) : undefined;
  return v?.width && v.height ? { w: v.width, h: v.height } : SQUARE;
}

/** The open form's regions, for the Stage: its Regions input, the boxes, how to change them, and the size it renders at. */
export interface RegionsHere {
  /** The form's Regions input; none when its model takes no regions (`off` says why). */
  spec: RegionsSpec | null;
  /** Why the model takes no regions (its recipe's `absent` row): the boxes the draft holds shown greyed. */
  off?: Absent;
  regions: RegionValue[];
  set(regions: RegionValue[]): void;
  size: Size;
  family: string;
  draftId: string | undefined;
}

/** The boxes a draft holds in the form of another model it was on (the first form with any), for a model that takes none. */
export function heldElsewhere(forms: Record<string, Record<string, unknown>> | undefined): RegionValue[] {
  for (const form of Object.values(forms ?? {})) {
    const found = regionList(form.regions);
    if (found.length) return found;
  }
  return [];
}

export function useRegionsHere(): RegionsHere | null {
  const target = useFormTarget((s) => s.target);
  if (!target) return null;
  const spec = regionsSpecOf(target.recipe.inputs) ?? null;
  const off = spec ? undefined : regionsAbsent(target.recipe.absent);
  if (!spec && !off) return null;
  const whole = target.whole ?? target.values;
  // on a model that takes none, the boxes of the draft's form on another model, shown greyed: never sent, never changed
  const regions = spec ? regionList(whole[spec.id]) : heldElsewhere(target.forms);
  return {
    spec,
    off,
    regions,
    set: (list) => {
      if (spec) target.set(spec.id, list);
    },
    size: formSize(target.recipe.inputs, whole),
    family: target.recipe.family,
    draftId: target.draftId,
  };
}
