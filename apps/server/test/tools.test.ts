import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
import type { Graph } from "@studai/core";
import { sweep } from "../src/sweep";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  const catalog = referenceCatalog();
  catalog.UpscaleModelLoader!.input.required!.model_name = [["anime_x4.pth", "RealESRGAN_x4plus.pth"]];
  fake = await startFakeComfy({
    catalog,
    models: {
      checkpoints: [CHECKPOINT], upscale_models: ["anime_x4.pth", "RealESRGAN_x4plus.pth"],
      diffusion_models: ["minimax_h3_fl2va_fp8.safetensors", "flux-2-klein-base-4b.safetensors"], text_encoders: ["qwen_3_4b.safetensors"], vae: ["flux2-vae.safetensors"],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const plain = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 150 } } }).png().toBuffer();
/** A mask the way the painter saves it: black, with the painted part in white. */
const painted = (width: number, height: number, part?: { left: number; top: number; width: number; height: number }) =>
  sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(part ? [{ input: { create: { width: part.width, height: part.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: part.left, top: part.top }] : [])
    .png().toBuffer();
const upload = async (bytes: Buffer, query = "") => {
  const res = await t.app.inject({ method: "POST", url: `/api/assets?${query}`, headers: { "content-type": "image/png" }, payload: bytes });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json() as { id: string; origin: string };
};
const nodes = (graph: Graph, cls: string) => Object.values(graph).filter((n) => n.class_type === cls);
/** Queue one job and answer with its graph once the pretend ComfyUI has it. */
async function graphOf(recipe: string, input: Record<string, unknown>) {
  const before = fake.prompts.size;
  const res = await post(t.app, "/api/jobs", { recipe, input });
  if (res.statusCode >= 400) throw new Error(res.body);
  await until(() => fake.prompts.size === before + 1);
  const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
  // let it finish, so that the next one can start
  complete(fake, promptId);
  await until(async () => (await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute()).length === 0);
  return graph;
}
/** Queue one job that cannot run and answer with why. */
async function refusal(recipe: string, input: Record<string, unknown>) {
  const id = (await post(t.app, "/api/jobs", { recipe, input })).json().ids[0] as string;
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "failed");
  return (await t.db.selectFrom("jobs").select("error").where("id", "=", id).executeTakeFirstOrThrow()).error;
}

describe("painting over a part of a picture", () => {
  it("redoes only what was painted, with room around it, and keeps the mask out of the library", async () => {
    const picture = await upload(await plain(400, 600), "name=terrace.png");
    const mask = await upload(await painted(400, 600, { left: 100, top: 200, width: 100, height: 100 }), `as=mask&name=mask:${picture.id}`);
    expect(mask.origin).toBe("mask");
    expect((await get(t.app, "/api/assets")).json().items.map((a: { id: string }) => a.id)).toEqual([picture.id]);

    const graph = await graphOf("sdxl.paint-over", { source: picture.id, mask: mask.id, prompt: "a red cup", checkpoint: CHECKPOINT });
    // 100 × 100 painted, 48 pixels of room on every side
    expect(nodes(graph, "ImageCrop")[0]!.inputs).toMatchObject({ x: 52, y: 152, width: 196, height: 196 });
    expect(nodes(graph, "CropMask")[0]!.inputs).toMatchObject({ x: 52, y: 152, width: 196, height: 196 });
    // a small part is redrawn three times larger at most, then put back where it was
    expect(nodes(graph, "KSampler")[0]!.inputs).toMatchObject({ denoise: 0.75 });
    expect(nodes(graph, "ImageCompositeMasked")[0]!.inputs).toMatchObject({ x: 52, y: 152 });
    expect(nodes(graph, "ImageScale").map((n) => [n.inputs.width, n.inputs.height])).toContainEqual([592, 592]);
  });

  it("is refused when nothing is painted, or when the paint belongs to another picture", async () => {
    const picture = await upload(await plain(400, 600));
    const empty = await upload(await painted(400, 600), "as=mask");
    expect(await refusal("sdxl.paint-over", { source: picture.id, mask: empty.id, prompt: "a", checkpoint: CHECKPOINT })).toContain("The mask is empty");
    const other = await upload(await painted(300, 300, { left: 10, top: 10, width: 50, height: 50 }), "as=mask");
    expect(await refusal("sdxl.paint-over", { source: picture.id, mask: other.id, prompt: "a", checkpoint: CHECKPOINT })).toContain("painted on another picture");
  });

  it("with FLUX.2 Klein draws the part anew at full strength and touches it up below", async () => {
    const picture = await upload(await plain(800, 800));
    const mask = await upload(await painted(800, 800, { left: 300, top: 300, width: 200, height: 200 }), "as=mask");
    const fresh = await graphOf("klein.paint-over", { source: picture.id, mask: mask.id, prompt: "Replace the cup with a glass." });
    expect(nodes(fresh, "EmptyFlux2LatentImage")).toHaveLength(1);
    expect(nodes(fresh, "SetLatentNoiseMask")).toHaveLength(0);
    expect(nodes(fresh, "UNETLoader")[0]!.inputs.unet_name).toBe("flux-2-klein-base-4b.safetensors");
    const touched = await graphOf("klein.paint-over", { source: picture.id, mask: mask.id, prompt: "Smoother skin.", strength: 0.4 });
    expect(nodes(touched, "SetLatentNoiseMask")).toHaveLength(1);
    expect(nodes(touched, "SplitSigmasDenoise")[0]!.inputs.denoise).toBe(0.4);
  });

  it("forgets a mask nothing was made with after a week", async () => {
    const picture = await upload(await plain(400, 600));
    const used = await upload(await painted(400, 600, { left: 10, top: 10, width: 80, height: 80 }), "as=mask");
    const unused = await upload(await painted(400, 600, { left: 10, top: 10, width: 80, height: 80 }), "as=mask");
    await t.db.insertInto("generations").values({ id: "g", owner_id: "local", recipe_id: "sdxl.paint-over", recipe_version: 1, family: "sdxl", inputs: "{}", resolved: "{}", gen_ms: 1, created_at: new Date().toISOString() }).execute();
    await t.db.insertInto("generation_inputs").values({ generation_id: "g", asset_id: used.id, role: "mask" }).execute();
    await sweep(t.db, t.services.storage, Date.now() + 8 * 24 * 60 * 60_000);
    const left = (await t.db.selectFrom("assets").select("id").execute()).map((a) => a.id);
    expect(left).toContain(used.id);
    expect(left).toContain(picture.id);
    expect(left).not.toContain(unused.id);
  });
});

describe("the other things done to a picture", () => {
  it("enlarges with an upscale model this ComfyUI has, and goes over the result when it is small enough", async () => {
    const small = await upload(await plain(400, 600));
    const graph = await graphOf("sdxl.sharper", { source: small.id, checkpoint: CHECKPOINT });
    // the default file is not there: the best of what is there, not the anime one
    expect(nodes(graph, "UpscaleModelLoader")[0]!.inputs.model_name).toBe("RealESRGAN_x4plus.pth");
    expect(nodes(graph, "ImageScale")[0]!.inputs).toMatchObject({ width: 800, height: 1200 });
    expect(nodes(graph, "KSampler")[0]!.inputs).toMatchObject({ denoise: 0.28, steps: 14 });

    const large = await upload(await plain(1700, 1700));
    const only = await graphOf("sdxl.sharper", { source: large.id, checkpoint: CHECKPOINT });
    expect(nodes(only, "ImageScale")[0]!.inputs).toMatchObject({ width: 3400, height: 3400 });
    expect(nodes(only, "KSampler")).toHaveLength(0);
  });

  it("redraws a picture at its own shape", async () => {
    const wide = await upload(await plain(1600, 900));
    const graph = await graphOf("sdxl.redraw", { source: wide.id, prompt: "a harbour at dusk", checkpoint: CHECKPOINT, strength: 0.4 });
    expect(nodes(graph, "ImageScale")[0]!.inputs).toMatchObject({ width: 1368, height: 768 });
    expect(nodes(graph, "KSampler")[0]!.inputs).toMatchObject({ denoise: 0.4 });
    // one that is already about the size SDXL draws at keeps its own size
    const near = await upload(await plain(1216, 832));
    expect(nodes(await graphOf("sdxl.redraw", { source: near.id, prompt: "a", checkpoint: CHECKPOINT }), "ImageScale")[0]!.inputs).toMatchObject({ width: 1216, height: 832 });
  });

  it("brings a picture to another shape by drawing only the room that is added", async () => {
    const tall = await upload(await plain(600, 900));
    const graph = await graphOf("klein.change-shape", { source: tall.id, shape: "Square 1:1" });
    expect(nodes(graph, "ImagePadForOutpaint")[0]!.inputs).toMatchObject({ left: 150, right: 150, top: 0, bottom: 0 });
    expect(nodes(graph, "Flux2Scheduler")[0]!.inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(String(nodes(graph, "CLIPTextEncode")[0]!.inputs.text)).toContain("Everything already in the picture stays exactly the same");
    // the whole frame is drawn, shown the picture with its empty room; the picture is then put back over it
    expect(nodes(graph, "EmptyFlux2LatentImage")).toHaveLength(1);
    expect(nodes(graph, "ImageCompositeMasked")).toHaveLength(1);
  });

  it("changes a picture from an instruction, telling the model which picture is which", async () => {
    const her = await upload(await plain(768, 1024));
    const place = await upload(await plain(1024, 768));
    const graph = await graphOf("klein.edit", { source: her.id, prompt: "Put her on the terrace.", references: [{ asset: place.id, role: "place" }] });
    expect(nodes(graph, "CLIPTextEncode")[0]!.inputs.text).toBe("Picture 1 is the picture to change. Picture 2 shows the place: the scene is there. Put her on the terrace.");
    expect(nodes(graph, "ReferenceLatent")).toHaveLength(4);
    // about a megapixel, at the shape of the picture being changed
    expect(nodes(graph, "EmptyFlux2LatentImage")[0]!.inputs).toMatchObject({ width: 880, height: 1184 });
  });

  it("makes a variation of a picture: the same thing, a little differently", async () => {
    const her = await upload(await plain(768, 1024));
    const plainly = await graphOf("klein.variation", { source: her.id });
    expect(nodes(plainly, "CLIPTextEncode")[0]!.inputs.text).toBe("The same picture as picture 1 with a slightly different pose, expression and camera angle; the same people, place, clothes and light. Photorealistic.");
    expect(nodes(plainly, "EmptyFlux2LatentImage")[0]!.inputs).toMatchObject({ width: 880, height: 1184 });
    const drawn = await graphOf("klein.variation", { source: her.id, prompt: "she laughs.", photo: false });
    expect(nodes(drawn, "CLIPTextEncode")[0]!.inputs.text).toBe("The same picture as picture 1 with she laughs; the same people, place, clothes and light. In exactly the same art style.");
  });

  it("lists every way of changing a picture, ready or not", async () => {
    const all = (await get(t.app, "/api/recipes")).json();
    const takesOne = all.recipes.filter((r: { output: string; inputs: Array<{ type: string; role?: string; optional?: boolean }> }) => r.output === "image" && r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional));
    expect(takesOne.map((r: { id: string }) => r.id)).toEqual([
      "sdxl.redraw", "sdxl.paint-over", "sdxl.sharper", "sdxl.fix-face", "klein.edit", "klein.variation", "klein.paint-over", "klein.change-shape", "klein.sharper", "klein.fix-face", "krea2.redraw", "krea2.paint-over", "krea2.sharper", "krea2.fix-face",
      "flux.edit", "flux.redraw", "flux.paint-over", "flux.sharper", "flux.fix-face", "qwen.edit", "qwen.redraw", "qwen.paint-over", "qwen.sharper", "qwen.fix-face", "tools.remove-background",
    ]);
    const setup = (await get(t.app, "/api/setup")).json();
    const of = (id: string) => setup.recipes.find((r: { id: string }) => r.id === id);
    expect(of("klein.picture")).toMatchObject({ ready: true });
    // the pretend ComfyUI has upscale models, but no face finder and no model that finds the background
    expect(of("sdxl.sharper")).toMatchObject({ ready: true, options: { upscaler: ["anime_x4.pth", "RealESRGAN_x4plus.pth"] } });
    expect(of("sdxl.fix-face")).toMatchObject({ ready: false, emptyInputs: ["detector"] });
    expect(of("tools.remove-background")).toMatchObject({ ready: false, emptyInputs: ["model"] });
  });
});
