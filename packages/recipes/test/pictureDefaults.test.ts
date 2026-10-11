import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type InputSpec, type Recipe } from "@afflatus/core";
import { fluxPicture, krea2Picture, qwenPicture, qwen21Picture, recipeById, recipes, sdxlTextToPicture, zimagePicture } from "../src";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const all = (b: { graph: Graph }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls).map((n) => n.inputs);
const defaultOf = (r: Recipe<any>, id: string) => (r.inputs.find((i) => i.id === id) as { default?: unknown } | undefined)?.default;

/** What the form starts a file on, as apps/web/src/form.ts reads the presets: every match counts, each setting from the first that has it. */
const startsOn = (r: Recipe<any>, file: string) => {
  const matched = (r.presets ?? []).filter((p) => new RegExp(p.match, "i").test(file));
  const values: Record<string, unknown> = Object.assign({}, ...[...matched].reverse().map((p) => p.values));
  return Object.fromEntries(r.inputs.filter((i) => i.id in values).map((i) => [i.id, values[i.id]]));
};

const files = {
  krea2: { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b.safetensors", vae: "qwen_image_vae.safetensors" },
  qwen: { unet: "qwen_image_2512.safetensors", clip: "qwen_2.5_vl_7b.safetensors", vae: "qwen_image_vae.safetensors" },
};

describe("hires fix starts where each family's authors put it", () => {
  it("Z-Image and Krea 2 enlarge 1.5× and redraw little; the others keep the flow kit's 1.25×, 0.4 and half the steps", () => {
    const hires = (r: Recipe<any>) => [defaultOf(r, "hiresScale"), defaultOf(r, "hiresDenoise"), defaultOf(r, "hiresSteps")];
    expect(hires(zimagePicture)).toEqual([1.5, 0.3, 4]);
    expect(hires(krea2Picture)).toEqual([1.5, 0.35, 4]);
    expect(hires(fluxPicture)).toEqual([1.25, 0.4, 10]);
    expect(hires(qwenPicture)).toEqual([1.25, 0.4, 25]);
  });

  it("Krea 2 keeps the model's own shift on a hires pass, in tiles and after an upscale, and a shift typed in still counts", () => {
    const build = (over: Record<string, unknown>) =>
      krea2Picture.build(parseInput(krea2Picture, { prompt: "a vase", hires: true, hiresUpscaler: "u.pth", ...over }), dryContext({ seed: 1, slots: files.krea2 }));
    for (const b of [build({}), build({ hiresScale: 3 })]) {
      expect(all(b, "ModelSamplingFlux")).toEqual([]);
      expect(all(b, "ModelSamplingAuraFlow")).toEqual([]);
    }
    const typed = build({ shift: 4 });
    expect(all(typed, "ModelSamplingAuraFlow").map((n) => n.shift)).toEqual([4, 4]);
    const sharper = recipeById("krea2.sharper")!;
    for (const width of [1024, 2048]) {
      const s = sharper.build(parseInput(sharper, { source: "p", upscaler: "u.pth" }), dryContext({ seed: 1, slots: files.krea2, uploads: { source: "s.png" }, media: { source: { width, height: width } } }));
      expect(all(s, "KSampler").length, String(width)).toBeGreaterThan(0);
      expect(all(s, "ModelSamplingFlux"), String(width)).toEqual([]);
    }
  });

  it("Qwen Image with Turbo, or a model made for a few steps, redraws in its few steps at CFG 1", () => {
    const build = (over: Record<string, unknown>, slots: Record<string, string> = files.qwen) =>
      all(qwenPicture.build(parseInput(qwenPicture, { prompt: "a vase", hires: true, hiresUpscaler: "u.pth", ...over }), dryContext({ seed: 1, slots })), "KSampler").map((k) => [k.steps, k.cfg]);
    expect(build({ fast: true }, { ...files.qwen, turbo: "lightning.safetensors" })).toEqual([[4, 1], [4, 1]]);
    expect(build({ model: "someone_qwen_image_lightning_8steps.safetensors", turboSteps: 8 })).toEqual([[8, 1], [8, 1]]);
    // fewer hires steps than the Turbo steps are kept as asked
    expect(build({ fast: true, hiresSteps: 2 }, { ...files.qwen, turbo: "lightning.safetensors" })).toEqual([[4, 1], [2, 1]]);
    // the full model, and Turbo with no LoRA to make it so: the full model's hires steps
    expect(build({})).toEqual([[50, 4], [25, 4]]);
    expect(build({ fast: true })).toEqual([[50, 4], [25, 4]]);
  });
});

describe("what a model file starts on, by its name", () => {
  it("Z-Image Turbo runs 8 steps, as ComfyUI's template does now", () => {
    expect(defaultOf(zimagePicture, "steps")).toBe(8);
  });

  it("Krea 2 RAW: the undistilled model's many steps and real CFG; Turbo and its fine-tunes are left alone", () => {
    expect(startsOn(krea2Picture, "krea2_raw_bf16.safetensors")).toEqual({ steps: 52, cfg: 3.5, hiresSteps: 26 });
    expect(startsOn(recipeById("krea2.redraw")!, "Krea-2-RAW.safetensors")).toMatchObject({ steps: 52, cfg: 3.5 });
    expect(startsOn(krea2Picture, "krea2_turbo_fp8_scaled.safetensors")).toEqual({});
  });

  it("a distilled FLUX.2 Klein runs 4 steps at CFG 1 on every Klein recipe; the base model keeps its 20 at CFG 5", () => {
    const klein = recipes.filter((r) => r.family === "klein");
    expect(klein.length).toBeGreaterThan(5);
    for (const r of klein) expect(startsOn(r, "flux-2-klein-4b.safetensors"), r.id).toMatchObject({ steps: 4, cfg: 1 });
    expect(startsOn(recipeById("klein.picture")!, "flux-2-klein-9b-fp8.safetensors")).toEqual({ steps: 4, cfg: 1, hiresSteps: 3 });
    for (const name of ["flux-2-klein-base-4b.safetensors", "Klein\\flux-2-klein-base-9b.safetensors", "minimax_h3_klein.safetensors"]) {
      expect(startsOn(recipeById("klein.picture")!, name.split("\\").pop()!), name).toEqual({});
    }
  });

  it("FLUX.1 schnell redraws a hires pass in 3 steps", () => {
    expect(startsOn(fluxPicture, "flux1-schnell-fp8.safetensors")).toEqual({ steps: 4, hiresSteps: 3 });
  });

  it("SDXL: DMD2 and LCM on sgm_uniform, few-step checkpoints on a few hires steps, Animagine 4.0's own CFG and tags", () => {
    expect(startsOn(sdxlTextToPicture, "illustriousDMD2_v1.safetensors")).toMatchObject({ sampler: "lcm", scheduler: "sgm_uniform", steps: 8, cfg: 1, hiresSteps: 4 });
    expect(startsOn(sdxlTextToPicture, "juggernautXL_v9Lightning.safetensors")).toMatchObject({ steps: 8, hiresSteps: 4 });
    expect(startsOn(sdxlTextToPicture, "dreamshaperXL_v21TurboDPMSDE.safetensors")).toMatchObject({ steps: 8, cfg: 2, hiresSteps: 4 });
    expect(startsOn(sdxlTextToPicture, "animagineXL40_v40.safetensors")).toMatchObject({ cfg: 5, quality: "masterpiece, high score, great score, absurdres" });
    // the tools have no hires pass: the preset gives them what they have
    expect(startsOn(recipeById("sdxl.redraw")!, "x_lightning.safetensors")).not.toHaveProperty("hiresSteps");
  });

  it("SDXL Lightning and Hyper files made for 2 or 4 steps run that many; the rest of the line its 8", () => {
    const steps = (name: string) => startsOn(sdxlTextToPicture, name).steps;
    expect(steps("sdxl_lightning_4step.safetensors")).toBe(4);
    expect(steps("sdxl_lightning_2step_unet.safetensors")).toBe(2);
    expect(steps("Hyper-SDXL-4steps.safetensors")).toBe(4);
    expect(steps("Hyper-SDXL-8steps.safetensors")).toBe(8);
    expect(steps("juggernautXL_v9Lightning4S.safetensors")).toBe(8);
    expect(startsOn(sdxlTextToPicture, "sdxl_lightning_4step.safetensors")).toMatchObject({ sampler: "euler", scheduler: "sgm_uniform", cfg: 1 });
    // a count with no Lightning or Hyper in the name is not one of theirs
    expect(steps("someMerge_4steps.safetensors")).toBeUndefined();
    expect(steps("sdxl_lightning_14step.safetensors")).toBe(8);
  });
});

describe("the shapes a new picture is offered", () => {
  const sizeOf = (r: Recipe<any>) => r.inputs.find((i) => i.type === "size") as Extract<InputSpec, { type: "size" }>;
  const pictures: Array<[Recipe<any>, [number, number]]> = [
    [sdxlTextToPicture, [1344, 768]],
    [fluxPicture, [1360, 768]],
    [krea2Picture, [1360, 768]],
    [recipeById("klein.picture")!, [1360, 768]],
    [qwenPicture, [1664, 928]],
    [qwen21Picture, [1376, 768]],
    [zimagePicture, [1280, 720]],
  ];

  it("16:9 both ways on every picture model, on its grid and within its sizes", () => {
    for (const [r, [w, h]] of pictures) {
      const size = sizeOf(r);
      const shapes = size.shapes.map((s) => [s.width, s.height]);
      expect(shapes, r.id).toContainEqual([w, h]);
      expect(shapes, r.id).toContainEqual([h, w]);
      expect(size.shapes.find((s) => s.width === w && s.height === h)!.label, r.id).toBe("Landscape 16:9");
      for (const s of size.shapes) {
        expect([s.width % size.grid, s.height % size.grid], `${r.id} ${s.id}`).toEqual([0, 0]);
        expect(Math.max(s.width, s.height), `${r.id} ${s.id}`).toBeLessThanOrEqual(size.max);
        if (size.maxPixels) expect(s.width * s.height, `${r.id} ${s.id}`).toBeLessThanOrEqual(size.maxPixels);
      }
      expect(new Set(size.shapes.map((s) => s.id)).size, r.id).toBe(size.shapes.length);
    }
  });

  it("Qwen Image 2.1 offers its authors' 2K sizes, and takes them", () => {
    const shapes = sizeOf(qwen21Picture).shapes.map((s) => `${s.width}x${s.height}`);
    for (const s of ["2752x1536", "1536x2752", "2400x1792", "1792x2400", "2528x1696", "1696x2528", "2048x2048"]) expect(shapes).toContain(s);
    expect(parseInput(qwen21Picture, { prompt: "a", size: { width: 2752, height: 1536 } }).size).toEqual({ width: 2752, height: 1536 });
  });
});
