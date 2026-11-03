import { describe, expect, it } from "vitest";
import { defineRecipe } from "@afflatus/core";
import { recipes } from "../src";
import { pictureForm, pictureRowsOf, PICTURE_DROPS } from "../src/shared/pictureForm";

// every picture form alike (the owner's H3 rule, applied to pictures on 2026-11-04; card #275): each takes its operation's
// rows in the same order and words, or says why it does not
const PICTURE_FAMILIES = ["sdxl", "klein", "krea2", "flux", "qwen", "qwen21", "zimage"];
const forms = recipes.filter((r) => PICTURE_FAMILIES.includes(r.family));

describe("picture forms laid out by pictureForm", () => {
  it.each(forms.map((r) => [r.id, r] as const))("%s takes every row of its operation, or drops it with why", (id, recipe) => {
    const made = PICTURE_DROPS.get(id);
    expect(made, `${id} is not laid out by pictureForm`).toBeDefined();
    const ids = recipe.inputs.map((i) => i.id);
    const shared = pictureRowsOf(made!.op, ids[0]);
    for (const row of shared) expect(ids.includes(row) || Boolean(made!.drop[row]?.trim()), `${id} · ${row}`).toBe(true);
    // the model first, the seed last, the shared rows in their order
    expect(ids[0]).toMatch(/^(model|checkpoint)$/);
    expect(ids.at(-1)).toBe("seed");
    const order = ids.filter((i) => shared.includes(i));
    expect(order).toEqual(shared.filter((i) => ids.includes(i)));
  });

  it("gives a shared row the same words on every form that has it", () => {
    const labels = new Map<string, Map<string, string[]>>();
    for (const r of forms) {
      const { op } = PICTURE_DROPS.get(r.id)!;
      const shared = pictureRowsOf(op, r.inputs[0]!.id);
      for (const i of r.inputs.filter((i) => shared.includes(i.id))) {
        // an edit's text is its instruction (said so on every edit), the model's row is SDXL's checkpoint
        const key = i.id === "prompt" && op === "edit" ? "instruction" : i.id;
        const seen = labels.get(key) ?? new Map<string, string[]>();
        seen.set(i.label, [...(seen.get(i.label) ?? []), r.id]);
        labels.set(key, seen);
      }
    }
    const differing = [...labels].filter(([id, seen]) => seen.size > 1 && id !== "model").map(([id, seen]) => `${id}: ${[...seen].map(([l, ids]) => `"${l}" (${ids.join(", ")})`).join(" / ")}`);
    expect(differing).toEqual([]);
    expect([...labels.get("instruction")!.keys()]).toEqual(["Instruction"]);
  });

  it("calls the pictures an edit reads Reference images on every edit", () => {
    for (const r of forms.filter((r) => PICTURE_DROPS.get(r.id)!.op === "edit")) {
      const refs = r.inputs.find((i) => i.id === "references");
      expect(refs?.label ?? `dropped: ${PICTURE_DROPS.get(r.id)!.drop.references}`, r.id).toMatch(/^Reference images$|^dropped: \S/);
    }
  });

  it("keeps a form's own rows after the shared row they came after", () => {
    const made = pictureForm("img2img", defineRecipe({
      id: "zz.redraw", family: "zz", version: 1, title: "zz", summary: "zz", output: "image", variants: [], nodes: () => [], build: () => { throw new Error("zz"); },
      inputs: [
        { id: "source", type: "image", role: "source", label: "Image" },
        { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
        { id: "own", type: "toggle", label: "Own", default: false },
        { id: "model", type: "model", label: "Model", folder: "diffusion_models" },
        { id: "seed", type: "seed", label: "Seed" },
      ],
    }), Object.fromEntries(["strength", "loras", "negative", "steps", "cfg", "sampler", "scheduler", "shift", "precision"].map((id) => [id, "zz"])));
    expect(made.inputs.map((i) => i.id)).toEqual(["model", "source", "prompt", "own", "seed"]);
    PICTURE_DROPS.delete("zz.redraw");
  });

  it("refuses a form that leaves a shared row out without saying why, or drops one it has or its operation does not share", () => {
    const zz = (inputs: Parameters<typeof defineRecipe>[0]["inputs"]) => defineRecipe({ id: "zz.edit", family: "zz", version: 1, title: "zz", summary: "zz", output: "image", variants: [], nodes: () => [], build: () => { throw new Error("zz"); }, inputs });
    const rows = pictureRowsOf("edit").map((id) => ({ id, type: "number" as const, label: id, min: 0, max: 1, step: 1, default: 0 }));
    expect(() => pictureForm("edit", zz(rows.filter((i) => i.id !== "negative")))).toThrow(/leaves out the edit row negative/);
    expect(() => pictureForm("edit", zz(rows), { size: "zz" })).toThrow(/drops size, which its operation \(edit\) does not share/);
    expect(() => pictureForm("edit", zz(rows), { negative: "zz" })).toThrow(/drops negative and has it/);
    PICTURE_DROPS.delete("zz.edit");
  });
});
