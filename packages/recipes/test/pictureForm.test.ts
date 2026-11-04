import { describe, expect, it } from "vitest";
import { defineRecipe, dryContext, parseInput } from "@afflatus/core";
import { recipes } from "../src";
import { GUIDE, noGuide, noReferences, pictureForm, pictureRowsOf, PICTURE_DROPS, REFERENCES } from "../src/shared/pictureForm";

// every picture form alike (the owner's H3 rule, applied to pictures on 2026-11-04; card #275): each takes its operation's
// rows in the same order and words, or says why it does not
const PICTURE_FAMILIES = ["sdxl", "klein", "krea2", "flux", "qwen", "qwen21", "zimage"];
// a hidden recipe is no form (an Edit in box is the Stage's, card #284)
const forms = recipes.filter((r) => PICTURE_FAMILIES.includes(r.family) && !r.hidden);

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

  // SDXL alone kept the size per model before (an SDXL checkpoint's 832×1216 is not what Qwen Image draws at)
  it("remembers the size per model on every txt2img", () => {
    for (const r of forms.filter((r) => PICTURE_DROPS.get(r.id)!.op === "txt2img")) expect(r.inputs.find((i) => i.id === "size")?.perModel, r.id).toBe(true);
  });

  // Klein extended to an aspect ratio, the others by the sides (card #275): every outpaint does both now
  it("outpaints by the sides or to an aspect ratio on every family", () => {
    const outpaints = forms.filter((r) => PICTURE_DROPS.get(r.id)!.op === "outpaint");
    expect(outpaints.map((r) => r.family).sort()).toEqual([...PICTURE_FAMILIES].sort());
    for (const r of outpaints) {
      const v = r.variants[0]!;
      const pads = (shape: string, more: Record<string, unknown> = {}) => {
        const input = parseInput(r, { ...v.input, shape, ...more });
        const built = r.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: { source: { width: 1000, height: 1000 } } }));
        return Object.values(built.graph).find((n) => n.class_type === "ImagePadForOutpaint")!.inputs;
      };
      expect(pads("Widescreen 16:9"), r.id).toMatchObject({ left: 389, right: 389, top: 0, bottom: 0 });
      expect(pads("Custom", { padLeft: 0, padRight: 256, padTop: 64, padBottom: 0 }), r.id).toMatchObject({ left: 0, right: 256, top: 64, bottom: 0 });
      expect(() => pads("Square 1:1"), r.id).toThrow(/Square 1:1 already/);
    }
  });

  // SDXL's rule before, now every family's (card #275): a face is redrawn in the form's steps, at least 8, at most 30
  it("redraws a face in 8 to 30 steps on every face refine", () => {
    const faces = forms.filter((r) => PICTURE_DROPS.get(r.id)!.op === "face");
    expect(faces).toHaveLength(PICTURE_FAMILIES.length);
    for (const r of faces) {
      const v = r.variants[0]!;
      const stepsAt = (steps: number) => {
        const built = r.build(parseInput(r, { ...v.input, steps }), dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {} }));
        return Object.values(built.graph).filter((n) => n.class_type === "FaceDetailer").map((n) => n.inputs.steps);
      };
      expect([stepsAt(4), stepsAt(20), stepsAt(50)], r.id).toEqual([[8], [20], [30]]);
    }
  });

  it("calls the pictures an edit reads Reference images on every edit", () => {
    for (const r of forms.filter((r) => PICTURE_DROPS.get(r.id)!.op === "edit")) {
      const refs = r.inputs.find((i) => i.id === "references");
      expect(refs?.label ?? `dropped: ${PICTURE_DROPS.get(r.id)!.drop.references}`, r.id).toMatch(/^Reference images$|^dropped: \S/);
    }
  });

  // card #277: a control image and reference images on every txt2img and img2img, in the same rows, or dropped with why
  it("takes a control image and reference images on every txt2img and img2img, or says why not", () => {
    const forms2 = forms.filter((r) => ["txt2img", "img2img"].includes(PICTURE_DROPS.get(r.id)!.op));
    const has = (r: (typeof forms)[number], rows: string[]) => rows.every((id) => r.inputs.some((i) => i.id === id));
    const said = (r: (typeof forms)[number], id: string) => PICTURE_DROPS.get(r.id)!.drop[id];
    const table = Object.fromEntries(forms2.map((r) => [r.id, {
      guide: has(r, GUIDE) ? "yes" : said(r, "guide") ? "dropped" : "missing",
      references: r.inputs.some((i) => i.id === "references") ? "yes" : said(r, "references") ? "dropped" : "missing",
    }]));
    expect(Object.values(table).filter((t) => t.guide === "missing" || t.references === "missing")).toEqual([]);
    // the families the card covers, as built
    for (const id of ["sdxl.text-to-picture", "sdxl.redraw", "flux.text-to-picture", "flux.redraw", "qwen.text-to-picture", "qwen.redraw", "zimage.text-to-picture", "zimage.redraw"]) expect(table[id]?.guide, id).toBe("yes");
    for (const id of ["sdxl.text-to-picture", "sdxl.redraw", "flux.text-to-picture", "flux.redraw", "klein.picture", "krea2.text-to-picture"]) expect(table[id]?.references, id).toBe("yes");
    // a dropped guide or references row is shown greyed on the form, with why
    for (const r of forms2) for (const id of ["guide", "references"]) if (said(r, id)) expect(r.absent?.find((a) => a.id === id)?.why, `${r.id} · ${id}`).toBe(said(r, id));
    expect(REFERENCES).toEqual(["references", "referenceStrength"]);
  });

  it("reads FLUX.1's single Redux image of an older draft as its first reference image", () => {
    const flux = recipes.find((r) => r.id === "flux.text-to-picture")!;
    const input = parseInput(flux, { prompt: "a", look: "asset1", lookStrength: 0.4 }) as Record<string, unknown>;
    expect(input.references).toEqual([{ asset: "asset1", role: "style" }]);
    expect(input.referenceStrength).toBe(0.4);
    expect(input).not.toHaveProperty("look");
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
    }), { ...Object.fromEntries(["strength", "loras", "negative", "steps", "cfg", "sampler", "scheduler", "shift", "precision"].map((id) => [id, "zz"])), ...noGuide("zz"), ...noReferences("zz") });
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
