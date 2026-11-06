import { describe, expect, it } from "vitest";
import { dryContext, parseInput, podSlotFiles, timeKey, type Recipe } from "@afflatus/core";
import { familyById, recipeById, recipes } from "../src";
import { PICTURE_DROPS } from "../src/shared/pictureForm";
import { DETECTOR_FILES, SMALL_FACE_PX } from "../src/shared/adetail";

// ADetailer inside every txt2img (card #272): a face, hands or people redrawn by the render's own model in the same job
const txt2imgs = recipes.filter((r) => PICTURE_DROPS.get(r.id)?.op === "txt2img");

/** A txt2img built from its first variant with `over` on it, on a machine with the detectors (or `slots`). */
function build(r: Recipe<any>, over: Record<string, unknown>, slots: Record<string, string> = DETECTOR_FILES, uploads: Record<string, string> = {}) {
  const v = r.variants[0]!;
  return r.build(parseInput(r, { ...v.input, ...over }), dryContext({ slots: { ...v.slots, ...slots }, uploads: { ...v.uploads, ...uploads }, media: v.media ?? {} }));
}
const of = (graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Record<string, { class_type: string; inputs: Record<string, any> }>, ref: unknown) => graph[(ref as [string, number])[0]]!;

describe("txt2img's Detail rows", () => {
  it("are on every family's txt2img, off by default (the owner's call, 2026-11-04)", () => {
    expect(txt2imgs.map((r) => r.family).sort()).toEqual(["flux", "klein", "krea2", "moss", "qwen", "qwen21", "sdxl", "zimage"]);
    for (const r of txt2imgs) {
      for (const id of ["detailFace", "detailHands", "detailPerson"]) {
        const row = r.inputs.find((i) => i.id === id);
        expect(row, `${r.id} · ${id}`).toMatchObject({ type: "toggle", default: false, section: "out" });
      }
      // the size gate said in the "?"
      expect(r.inputs.find((i) => i.id === "detailFace")!.note, r.id).toContain(`under ${SMALL_FACE_PX} px tall`);
      // off, no pass: the picture is the same graph as before
      expect(of(build(r, {}).graph, "DetailerForEach"), r.id).toHaveLength(0);
    }
  });

  it("go over people, then hands, then faces, with the render's model, each kept by its size at the drawn size", () => {
    for (const r of txt2imgs) {
      const built = build(r, { detailFace: true, detailHands: true, detailPerson: true });
      const passes = of(built.graph, "DetailerForEach");
      // SDXL's face starts lighter: at 0.4 it made another person on the pod test (card #280), 0.3 still drifted (card #281);
      // Klein's at its Face refine's start (card #303)
      expect(passes.map((p) => p.inputs.denoise), r.id).toEqual([0.35, 0.35, r.family === "sdxl" ? 0.2 : r.family === "klein" ? 0.5 : 0.4]);
      // hands are found from 0.25, where hand_yolov8s found the small hands 0.5 missed; people and faces from 0.5 (card #281)
      expect([...of(built.graph, "SegmDetectorSEGS"), ...of(built.graph, "BboxDetectorSEGS")].map((n) => n.inputs.threshold).sort(), r.id).toEqual([0.25, 0.5, 0.5]);
      expect(node(built.graph, node(built.graph, passes[1]!.inputs.segs).inputs.segs).inputs.threshold, r.id).toBe(0.25);
      // each one goes over the picture the one before made
      expect(node(built.graph, passes[1]!.inputs.image)).toBe(passes[0]);
      expect(node(built.graph, passes[2]!.inputs.image)).toBe(passes[1]);
      // a person inside their outline, a face kept under 150 px (its crop's height: 3 face heights), hands of any size
      expect(of(built.graph, "SegmDetectorSEGS"), r.id).toHaveLength(1);
      expect(of(built.graph, "ImpactSEGSRangeFilter").map((n) => n.inputs.max_value), r.id).toEqual([Math.round(512 * 1.2), SMALL_FACE_PX * 3]);
      // each counted in the estimate, at the guide size (one of each: how many is known once found)
      expect(built.passes!.slice(-3).map((p) => p.pixels), r.id).toEqual([1024 * 1024, 1024 * 1024, 1024 * 1024]);
      expect(built.passes!.every((p) => p.pixels! > 0), r.id).toBe(true);
      expect(built.totalSteps, r.id).toBe(built.passes!.reduce((n, p) => n + p.steps, 0));
      expect(built.loads, r.id).toEqual(expect.arrayContaining(Object.values(DETECTOR_FILES).map((f) => `ultralytics/${f}`)));
    }
  });

  it("read the size gate at the size the picture was drawn: larger after a hires fix", () => {
    for (const r of txt2imgs) {
      const built = build(r, { detailFace: true, hires: true, hiresScale: 2, hiresUpscaler: "u.pth" });
      expect(of(built.graph, "ImpactSEGSRangeFilter")[0]!.inputs.max_value, r.id).toBe(SMALL_FACE_PX * 2 * 3);
      // after the hires fix: the upscaled picture is what is gone over
      expect(of(built.graph, "DetailerForEach")).toHaveLength(1);
    }
  });

  it("ask a pod for the detectors they use; a machine of the user's own without one makes the picture without that pass, and says so", () => {
    for (const r of txt2imgs) {
      const input = parseInput(r, { ...r.variants[0]!.input, detailFace: true, detailHands: true }) as Record<string, unknown>;
      const sent = Object.keys(podSlotFiles(r, input, familyById(r.family)!.slots, null, null));
      expect(sent, r.id).toEqual(expect.arrayContaining(["faceDetector", "handDetector"]));
      expect(sent, r.id).not.toContain("personDetector");
      expect(r.needsWith!(input, {}, { own: true }), r.id).toEqual([]);
      const without = build(r, { detailHands: true }, { faceDetector: DETECTOR_FILES.faceDetector! });
      expect(of(without.graph, "DetailerForEach"), r.id).toHaveLength(0);
      expect(without.warnings, r.id).toEqual([expect.stringContaining("Not detailed (hands): no hand detector")]);
    }
  });

  it("are done without when the Impact Pack is missing, the job saying so", () => {
    const r = txt2imgs.find((x) => x.family === "flux")!;
    const v = r.variants[0]!;
    const said: string[] = [];
    const ctx = dryContext({ slots: { ...v.slots, ...DETECTOR_FILES }, has: (n) => n !== "DetailerForEach" });
    const built = r.build(parseInput(r, { ...v.input, detailFace: true }), { ...ctx, wants: (w) => { said.push(w.without); return null; } });
    expect(of(built.graph, "DetailerForEach")).toHaveLength(0);
    expect(said).toEqual(["Detail: face"]);
  });

  it("redraw with a prompt of their own when one is typed, else the picture's", () => {
    const sdxl = txt2imgs.find((x) => x.family === "sdxl")!;
    const words = build(sdxl, { detailFace: true, detailFacePrompt: "green eyes", quality: "masterpiece" });
    expect(node(words.graph, of(words.graph, "DetailerForEach")[0]!.inputs.positive).inputs.text).toBe("masterpiece, green eyes");
    const own = build(sdxl, { detailFace: true, prompt: "a woman on a terrace" });
    expect(node(own.graph, of(own.graph, "DetailerForEach")[0]!.inputs.positive).inputs.text).toContain("a woman on a terrace");
  });

  it("redraw a cast person's face from their picture: Klein from its person references, Krea 2 by Face refine's pass", () => {
    const klein = txt2imgs.find((x) => x.family === "klein")!;
    const k = build(klein, { detailFace: true, detailHands: true, references: [{ asset: "a", role: "person" }, { asset: "c", role: "place" }] }, DETECTOR_FILES, { "references.0": "a.png", "references.1": "c.png" });
    const [hands, face] = of(k.graph, "DetailerForEach");
    expect(node(k.graph, face!.inputs.positive).class_type).toBe("ReferenceLatent");
    expect(node(k.graph, hands!.inputs.positive).class_type).toBe("CLIPTextEncode");

    const krea = txt2imgs.find((x) => x.family === "krea2")!;
    const person = { person: [{ asset: "p", role: "person" }], faceRefine: false, detailFace: true };
    const files = { ...DETECTOR_FILES, identityEdit: "id.safetensors", kleinUnet: "flux-2-klein-base-4b.safetensors", kleinClip: "qwen_3_4b.safetensors", kleinVae: "flux2-vae.safetensors" };
    const built = build(krea, person, files, { "person.0": "p.png" });
    const passes = of(built.graph, "DetailerForEach");
    expect(passes).toHaveLength(1);
    expect(node(built.graph, passes[0]!.inputs.model)).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-base-4b.safetensors" } });
    expect(krea.needsWith!(parseInput(krea, { prompt: "a", ...person }) as never)).toEqual(expect.arrayContaining(["kleinUnet", "faceDetector"]));
  });

  it("redraw only the largest persons and hands, not a crowd's every one, and say so in the \"?\" (card #280)", () => {
    for (const r of txt2imgs) {
      const built = build(r, { detailFace: true, detailHands: true, detailPerson: true });
      const [person, hands, face] = of(built.graph, "DetailerForEach");
      // the persons under the size gate, then their two largest by area
      const kept = node(built.graph, person!.inputs.segs);
      expect(kept, r.id).toMatchObject({ class_type: "ImpactSEGSOrderedFilter", inputs: { target: "area(=w*h)", order: true, take_start: 0, take_count: 2 } });
      expect(node(built.graph, kept.inputs.segs).class_type, r.id).toBe("ImpactSEGSRangeFilter");
      expect(node(built.graph, hands!.inputs.segs), r.id).toMatchObject({ class_type: "ImpactSEGSOrderedFilter", inputs: { take_count: 4 } });
      // hands have no size gate: their largest four of all those found
      expect(node(built.graph, node(built.graph, hands!.inputs.segs).inputs.segs).class_type, r.id).toBe("BboxDetectorSEGS");
      // every face under its gate, as before
      expect(node(built.graph, face!.inputs.segs).class_type, r.id).toBe("ImpactSEGSRangeFilter");
      expect(r.inputs.find((i) => i.id === "detailPerson")!.note, r.id).toContain("only the 2 largest");
      expect(r.inputs.find((i) => i.id === "detailHands")!.note, r.id).toContain("only the 4 largest");
      expect(r.inputs.find((i) => i.id === "detailFace")!.note, r.id).not.toContain("largest");
      // a machine without the filter (an old Impact Pack) makes the picture without the pass, as without the detailer
      expect(r.optionalNodes, r.id).toContain("ImpactSEGSOrderedFilter");
    }
  });

  it("start SDXL's face pass lighter, and SDXL's Face refine with it; the other families as they were (cards #280, #281)", () => {
    const denoise = (id: string, row: string) => (recipeById(id)!.inputs.find((i) => i.id === row) as { default: number }).default;
    expect(denoise("sdxl.text-to-picture", "detailFaceDenoise")).toBe(0.2);
    expect(denoise("sdxl.fix-face", "strength")).toBe(0.2);
    for (const r of txt2imgs.filter((x) => x.family !== "sdxl" && x.family !== "klein")) expect(denoise(r.id, "detailFaceDenoise"), r.id).toBe(0.4);
    expect(denoise("sdxl.text-to-picture", "detailHandsDenoise")).toBe(0.35);
  });

  it("start Klein's face passes on one value, Face refine's and Detail face's alike (card #303)", () => {
    const denoise = (id: string, row: string) => (recipeById(id)!.inputs.find((i) => i.id === row) as { default: number }).default;
    expect(denoise("klein.picture", "detailFaceDenoise")).toBe(denoise("klein.fix-face", "strength"));
    expect(denoise("klein.fix-face", "strength")).toBe(0.5);
  });

  it("leave the time key of a picture with them off as it was", () => {
    for (const r of txt2imgs) {
      const input = parseInput(r, r.variants[0]!.input) as Record<string, unknown>;
      expect(timeKey(r.inputs, input), r.id).not.toMatch(/detail(Face|Hands|Person)/);
      expect(timeKey(r.inputs, { ...input, detailFace: true }), r.id).toMatch(/detailFace=true/);
    }
  });
});
