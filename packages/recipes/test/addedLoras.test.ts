import { describe, expect, it } from "vitest";
import { addedRows, dryContext, OWN_MODEL, parseInput, type InputSpec, type Recipe } from "@afflatus/core";
import { recipeById, recipes } from "../src/index";

/** Card #160: every LoRA Afflatus adds by itself is a row of the LoRA list, with its file and its weight. */
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
const loaders = (graph: Graph, file: string) => of(graph, "LoraLoaderModelOnly").filter((n) => n.inputs.lora_name === file);

const TURBO = "minimax_h3_turbo.safetensors";
const REF_TURBO = "minimax_h3_ref2v_turbo.safetensors";
const REF = "minimax_h3_ref2va.safetensors";
const slots = {
  unet: "minimax_h3_fl2va.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: REF, rife: "rife.pth",
  turbo: TURBO, refTurbo: REF_TURBO, faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth",
};
const video = recipeById("h3.video")!;
const person = [{ asset: "r1", role: "person" }];

function build(values: Record<string, unknown>, extra: Record<string, string> = {}) {
  const input = parseInput(video, { description: "a", start: "p1", ...values });
  const built = video.build(input, dryContext({ seed: 7, slots: { ...slots, ...extra }, uploads: { start: "s.png", "references.0": "person.png" }, media: { start: { width: 576, height: 1024 } } }));
  return { input: input as unknown as Record<string, unknown>, graph: built.graph as Graph, built };
}
const lorasSpec = (r: Recipe<any>, id = "loras") => r.inputs.find((i) => i.id === id)!;

describe("H3's Turbo LoRA as a row of the LoRA list (card #160)", () => {
  it("is in every H3 form's list, its file and weight drawn in the row", () => {
    for (const id of ["h3.video", "h3.lipsync", "h3.swap", "h3.motion"]) {
      const r = recipeById(id)!;
      const list = lorasSpec(r);
      expect(list.type === "loras" && list.added?.map((a) => [a.label, a.toggle, a.file, a.weight]), id).toEqual([["Turbo", "fast", "turboLora", "turboWeight"]]);
      expect(r.inputs.find((i) => i.id === "turboLora"), id).toMatchObject({ type: "model", folder: "loras", blank: true, inList: "loras", showWhen: "fast", perModel: true });
      expect(r.inputs.find((i) => i.id === "turboWeight"), id).toMatchObject({ type: "number", default: 1, inList: "loras", showWhen: "fast", perModel: true });
    }
  });

  it("left as it starts, puts the slot's file on at 1, once (today's graph)", () => {
    const { input, graph } = build({ fast: true });
    expect(of(graph, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([[TURBO, 1]]);
    expect(addedRows(lorasSpec(video), input, slots).map((r) => [r.file, r.weight])).toEqual([[TURBO, 1]]);
    // a reference clip on MiniMax's reference model takes that model's own
    expect(of(build({ fast: true, references: person }).graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual([REF_TURBO]);
  });

  it("takes the row's weight and the file picked in it", () => {
    const { graph } = build({ fast: true, turboWeight: 0.8 });
    expect(loaders(graph, TURBO).map((n) => n.inputs.strength_model)).toEqual([0.8]);
    const picked = build({ fast: true, turboLora: "someone_h3_turbo4.safetensors", turboWeight: 0.6 }).graph;
    expect(of(picked, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["someone_h3_turbo4.safetensors", 0.6]]);
  });

  it("puts the same file added by hand on once, at the weight typed by hand", () => {
    // the owner's Swap (2026-10-29): Turbo on, and its LoRA at 0.8 in the list too, was 1 + 0.8
    const { input, graph } = build({ fast: true, loras: [{ file: TURBO, weight: 0.8 }, { file: "style.safetensors", weight: 0.5 }] });
    expect(loaders(graph, TURBO).map((n) => n.inputs.strength_model)).toEqual([0.8]);
    expect(loaders(graph, "style.safetensors")).toHaveLength(1);
    const [row] = addedRows(lorasSpec(video), input, slots);
    expect(row).toMatchObject({ file: TURBO, weight: 0.8, hand: 0 });
    // in another folder, the same file all the same
    expect(loaders(build({ fast: true, loras: [{ file: `H3\\${TURBO}`, weight: 0.7 }] }).graph, TURBO).map((n) => n.inputs.strength_model)).toEqual([0.7]);
  });

  it("has no row and no loader with Turbo off, and keeps its file and weight for when Turbo is on again", () => {
    const off = build({ fast: false, turboLora: "someone_h3_turbo4.safetensors", turboWeight: 0.7 });
    expect(of(off.graph, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(addedRows(lorasSpec(video), off.input, slots)).toEqual([]);
    expect(off.input).toMatchObject({ turboLora: "someone_h3_turbo4.safetensors", turboWeight: 0.7 });
    const on = build({ ...off.input, fast: true });
    expect(of(on.graph, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["someone_h3_turbo4.safetensors", 0.7]]);
  });

  it("at weight 0 is not loaded, Turbo's steps kept", () => {
    const { graph, built } = build({ fast: true, turboWeight: 0, turboSteps: 8 });
    expect(of(graph, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(built.totalSteps).toBeGreaterThanOrEqual(8);
    expect(built.loads?.some((l) => l.includes(TURBO))).toBe(false);
  });

  it("has no row on a distilled model, which takes no LoRA", () => {
    const { input, graph } = build({ fast: true, model: "dasiwa_h3_turbo_8steps.safetensors" });
    expect(of(graph, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(addedRows(lorasSpec(video), input, slots)).toEqual([]);
  });

  it("Face refine on the clip's own model keeps its turbo LoRA at the row's weight", () => {
    const { graph } = build({ fast: true, references: person, faceRefine: true, faceRefineModel: OWN_MODEL, turboWeight: 0.6 }, { faceRefineUnet: "fused_turbo.safetensors" });
    const sampler = of(graph, "SamplerCustomAdvanced").find((n) => node(graph, n.inputs.latent_image).class_type === "H3PerFrameDenoise")!;
    let model = node(graph, node(graph, sampler.inputs.latent_image).inputs.model);
    const chain: unknown[] = [];
    while (model.class_type !== "UNETLoader") {
      if (model.class_type === "LoraLoaderModelOnly") chain.push([model.inputs.lora_name, model.inputs.strength_model]);
      model = node(graph, model.inputs.model);
    }
    expect(model.inputs.unet_name).toBe(REF);
    expect(chain).toEqual([[REF_TURBO, 0.6]]);
  });
});

describe("the LoRAs a model needs, rows without a × (card #160)", () => {
  it("LTX's distilled LoRA: a row on a model that is not distilled, at its strength; at 0 not loaded", () => {
    const ltx = recipeById("ltx.video")!;
    const v = ltx.variants.find((x) => x.slots?.turbo)!;
    const run = (over: Record<string, unknown>) => {
      const input = parseInput(ltx, { ...(v.input as object), ...over }) as unknown as Record<string, unknown>;
      const graph = ltx.build(input as never, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas })).graph as Graph;
      return { input, graph, rows: addedRows(lorasSpec(ltx), input, v.slots ?? {}) };
    };
    const dev = run({ turboIn: "No" });
    expect(dev.rows.map((r) => [r.added.label, r.added.toggle, r.file, r.weight])).toEqual([["Needed by this model", undefined, v.slots!.turbo, 0.5]]);
    expect(loaders(dev.graph, v.slots!.turbo!).map((n) => n.inputs.strength_model)).toEqual([0.5]);
    expect(of(run({ turboIn: "No", loraStrength: 0 }).graph, "LoraLoaderModelOnly").filter((n) => n.inputs.lora_name === v.slots!.turbo)).toHaveLength(0);
    // a distilled model: no row, no loader
    const distilled = run({ turboIn: "Yes" });
    expect(distilled.rows).toEqual([]);
    expect(loaders(distilled.graph, v.slots!.turbo!)).toHaveLength(0);
  });

  it("SCAIL-2's DPO and step-distill LoRAs: two rows, their weights, at 0 not loaded", () => {
    const scail = recipes.find((r) => r.id.startsWith("scail."))!;
    const v = scail.variants[0]!;
    const run = (over: Record<string, unknown>) => {
      const input = parseInput(scail, { ...(v.input as object), ...over }) as unknown as Record<string, unknown>;
      const graph = scail.build(input as never, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {} })).graph as Graph;
      return { graph, rows: addedRows(lorasSpec(scail), input, v.slots ?? {}) };
    };
    const plain = run({});
    expect(plain.rows.map((r) => [r.file, r.weight])).toEqual([[v.slots!.dpo, 1], [v.slots!.turbo, 0.8]]);
    expect(plain.rows.every((r) => !r.added.toggle)).toBe(true);
    const off = run({ dpoStrength: 0, turboWeight: 0 }).graph;
    expect(of(off, "LoraLoaderModelOnly").filter((n) => n.inputs.lora_name === v.slots!.dpo || n.inputs.lora_name === v.slots!.turbo)).toHaveLength(0);
  });
});

/**
 * The row never lies: over a grid of every recipe with rows (its variants, Turbo, the model's kind, the files there), the
 * LoRAs the rows say (with a weight other than 0) are the ones the graph puts on, file and weight.
 */
describe("a row is shown exactly when the recipe puts its LoRA on (card #160)", () => {
  const withRows = recipes.filter((r) => r.inputs.some((i) => i.type === "loras" && i.added?.length));
  it("covers the families that add LoRAs themselves", () => {
    expect(withRows.map((r) => r.id)).toEqual(expect.arrayContaining(["h3.video", "h3.lipsync", "h3.swap", "h3.motion", "wan.video", "qwen.edit", "qwen.text-to-picture", "ltx.video", "ltx25.video", "krea2.text-to-picture"]));
  });

  for (const r of withRows) {
    it(r.id, () => {
      const lists = r.inputs.filter((i): i is Extract<InputSpec, { type: "loras" }> => i.type === "loras" && Boolean(i.added?.length));
      const has = new Set(r.inputs.map((i) => i.id));
      const rowSlots = [...new Set(lists.flatMap((l) => l.added!.flatMap((a) => a.slots.map((s) => s.slot))))];
      const grid: Array<Record<string, unknown>> = [];
      for (const fast of [true, false]) for (const turboIn of [undefined, "Yes", "No"]) for (const hybrid of [undefined, "Yes"]) for (const model of [undefined, "zz_i2v_turbo_8steps.safetensors", "zz_t2v_plain_dev.safetensors"]) {
        grid.push(Object.fromEntries(Object.entries({ fast, turboIn, hybrid, model, swapModel: model }).filter(([k, v]) => v !== undefined && has.has(k))));
      }
      const slotSets: Array<Record<string, string | undefined>> = [{}, ...rowSlots.map((s) => ({ [s]: undefined })), ...(r.family === "h3" ? [{ refUnet: "zz_ref2va_turbo_4steps.safetensors" }, { swapUnet: "zz_fused_turbo8.safetensors" }] : [])];
      let built = 0;
      let shown = 0;
      // the whole grid on the first variants, Turbo on and off on the others (a style reference, a pass left out)
      for (const [n, v] of r.variants.entries()) {
        for (const over of n < 4 ? grid : grid.slice(0, 1).concat(grid.filter((g) => g.fast === false).slice(0, 1))) for (const slotOver of n < 4 ? slotSets : [{}]) {
          const all: Record<string, string> = { ...Object.fromEntries(rowSlots.map((s) => [s, `zz_${s}_lora.safetensors`])), ...(v.slots ?? {}) };
          for (const [k, f] of Object.entries(slotOver)) if (f === undefined) delete all[k]; else all[k] = f;
          let input: Record<string, unknown>;
          let graph: Graph;
          try {
            input = parseInput(r, { ...(v.input as object), ...over }) as unknown as Record<string, unknown>;
            graph = r.build(input as never, dryContext({ slots: all, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) })).graph as Graph;
          } catch {
            continue;
          }
          built++;
          const rows = lists.flatMap((l) => addedRows(l, input, all));
          if (rows.length) shown++;
          // the files a row could name: its slots' and the picked ones
          const theirs = new Set([...rowSlots.map((s) => all[s]), ...lists.flatMap((l) => l.added!.map((a) => input[a.file]))].filter((f): f is string => typeof f === "string" && f !== ""));
          const said = new Set(rows.filter((x) => x.weight !== 0).map((x) => `${x.file}@${x.weight}`));
          const put = new Set(of(graph, "LoraLoaderModelOnly").filter((n) => theirs.has(String(n.inputs.lora_name))).map((n) => `${String(n.inputs.lora_name)}@${String(n.inputs.strength_model)}`));
          expect([...put].sort(), `${v.name} · ${JSON.stringify(over)} · ${JSON.stringify(slotOver)}`).toEqual([...said].sort());
        }
      }
      expect(built).toBeGreaterThan(0);
      // the grid holds both: rows shown, and none
      expect(shown, "rows shown somewhere").toBeGreaterThan(0);
      if (lists.some((l) => l.added!.some((a) => a.toggle))) expect(shown, "and nowhere else").toBeLessThan(built);
    });
  }
});
