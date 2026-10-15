import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { GraphBuilder } from "@afflatus/core";
import { coldOf } from "../src/queueSubmit";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, makeApp, png, post, referenceCatalog, until, type TestApp } from "./helpers";
import { H3_FILES, timelineSteps, timelineSuite } from "./timelineKit";

/**
 * The GPU is not held while a finished video is measured (H-3), a picture goes up to a machine once (M-3), and the
 * scheduler knows the model a recipe loads from its family's slot; a change of VAE alone frees nothing (M-8).
 */

// the look of a take is measured behind a gate the test opens: what waits for it, and what does not, can be seen
const gate = vi.hoisted(() => ({ closed: null as Promise<void> | null, open: () => {}, measured: 0 }));
vi.mock("../src/cut", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cut")>();
  return {
    ...real,
    lookOf: async (...args: Parameters<typeof real.lookOf>) => {
      if (gate.closed) await gate.closed;
      gate.measured++;
      return real.lookOf(...args);
    },
  };
});
const closeGate = () => {
  let open!: () => void;
  gate.measured = 0;
  gate.closed = new Promise<void>((go) => (open = go));
  gate.open = () => {
    gate.closed = null;
    open();
  };
  return gate.open;
};

/** Let a pretend ComfyUI finish its latest prompt with this video. */
function finishVideo(fake: FakeComfy, bytes: Uint8Array): string {
  const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
  const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
  fake.files[`${promptId}.mp4`] = bytes;
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
  return promptId;
}

describe.skipIf(!ffmpegThere)("a finished video", { timeout: FFMPEG_TIMEOUT }, () => {
  const s = timelineSuite();
  // a test that failed with the gate shut does not leave its measure waiting for ever (the app's close waits for it): run
  // before the suite's own hook closes the app
  afterEach(() => gate.open());
  const { call, render } = timelineSteps(s);
  const statusOf = async (id: string) => (await s.t.db.selectFrom("jobs").select(["status", "generation_id"]).where("id", "=", id).executeTakeFirstOrThrow());

  it("frees its machine once it is stored: the job is done and the next one sent while its take is measured", async () => {
    const open = closeGate();
    const job = async (description: string) => (await post(s.t.app, "/api/jobs", { recipe: "h3.video", input: { description } })).json().ids[0] as string;
    const a = await job("A lighthouse at dusk.");
    const b = await job("A boat in the harbour.");
    await until(() => s.fake.prompts.size === 1);
    finishVideo(s.fake, s.clips.three);
    // the GPU is not held by the measure: the job closes and the next prompt goes while the gate is still shut
    await until(async () => (await statusOf(a)).status === "done" && s.fake.prompts.size === 2);
    expect((await get(s.t.app, "/api/queue")).json().running.id).toBe(b);
    const generation = (await statusOf(a)).generation_id!;
    const measure = async () => (await s.t.db.selectFrom("generations").select("measure").where("id", "=", generation).executeTakeFirstOrThrow()).measure;
    expect(await measure()).toBeNull();
    // the take was filed whole meanwhile: its size, length and thumbnail
    const asset = await s.t.db.selectFrom("assets").selectAll().where("generation_id", "=", generation).executeTakeFirstOrThrow();
    expect(asset).toMatchObject({ width: expect.any(Number), height: expect.any(Number), duration_ms: 3000 });
    expect(asset.thumb_key).not.toBeNull();
    open();
    finishVideo(s.fake, s.clips.three);
    await s.t.services.queue.idle();
    // patched in once ready, in its column and in what the asset API hands out
    expect(JSON.parse((await measure())!)).toMatchObject({ luma: expect.any(Number), sharp: expect.any(Number) });
    const detail = (await get(s.t.app, `/api/assets/${asset.id}`)).json();
    expect(detail.generation.resolved.measure).toMatchObject({ luma: expect.any(Number) });
  });

  it("is measured before the clip that carries on from it sends its prompt, whose files go up meanwhile", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test filing" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    const open = closeGate();
    await render(tl.id, [{ id: a }, { id: b }]);
    await until(() => s.fake.prompts.size === 1, 20_000);
    const sent = s.fake.uploads.length;
    finishVideo(s.fake, s.clips.three);
    // the clip after cut its frames off the clip before and sent them, and waits for the clip before's figures
    await until(() => s.fake.uploads.length > sent, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.fake.prompts.size).toBe(1);
    expect(gate.measured).toBe(0);
    open();
    await until(() => s.fake.prompts.size === 2, 20_000);
    expect(gate.measured).toBeGreaterThan(0);
    finishVideo(s.fake, s.clips.three);
    await s.t.services.queue.idle();
  });
});

describe("a picture sent to a machine", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  it("goes up once for the jobs that use it there, under a name its content gives, and again once ComfyUI started again", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id as string;
    const run = async (prompt: string) => {
      const res = await post(t.app, "/api/jobs", { recipe: "sdxl.redraw", input: { source: picture, prompt, checkpoint: "illustrious.safetensors" } });
      const id = res.json().ids?.[0] as string;
      if (!id) throw new Error(res.body);
      const n = fake.prompts.size;
      await until(() => fake.prompts.size === n + 1);
      const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
      const out = Object.entries(graph).find(([, node]) => node.class_type === "PreviewImage")![0];
      fake.files[`${promptId}.png`] = png(64, 64);
      fake.pending = fake.pending.filter((p) => p !== promptId);
      fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { images: [{ filename: `${promptId}.png`, subfolder: "", type: "temp" }] } } };
      await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
      return Object.values(graph).find((node) => node.class_type === "LoadImage")!.inputs.image;
    };
    const first = await run("a cat");
    const second = await run("a dog");
    expect(fake.uploads.filter((u) => u.endsWith(".png"))).toHaveLength(1);
    expect(second).toBe(first);
    expect(String(first)).toMatch(/^afflatus_[0-9a-f]{32}\.png \[temp\]$/);
    // ComfyUI started again (its socket opened anew): its temp folder is empty, the picture goes up again
    (await t.services.comfy()).forgetAll();
    await run("a bird");
    expect(fake.uploads.filter((u) => u.endsWith(".png"))).toHaveLength(2);
  });
});

describe.skipIf(!ffmpegThere)("the scheduler, for a recipe whose model comes from its family's slot", { timeout: FFMPEG_TIMEOUT }, () => {
  let one: FakeComfy;
  let two: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    [one, two] = await Promise.all([startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES }), startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES })]);
    t = await makeApp({ comfyUrl: one.url });
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "zz-test one", url: one.url }, { id: "m2", name: "zz-test two", url: two.url }] } });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await Promise.all([one.close().catch(() => {}), two.close().catch(() => {})]);
  });

  it("keeps it on the machine that holds its model", async () => {
    const clip = await patternClip(1);
    const job = async (description: string, machine?: string) => (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description }, ...(machine ? { machine } : {}) })).json().ids[0] as string;
    const machineOf = async (id: string) => (await t.db.selectFrom("jobs").select(["status", "machine_id"]).where("id", "=", id).executeTakeFirstOrThrow());
    // the second machine renders H3 once: it holds H3's model; the first holds nothing that is known
    const first = await job("A lighthouse.", "m2");
    await until(() => two.prompts.size === 1);
    finishVideo(two, clip);
    await until(async () => (await machineOf(first)).status === "done");
    await t.services.queue.idle();
    const next = await job("A boat.");
    await until(() => one.prompts.size + two.prompts.size === 2);
    expect((await machineOf(next)).machine_id).toBe("m2");
    finishVideo(two, clip);
    await t.services.queue.idle();
  });
});

describe("a model loaded for the last render", () => {
  const graph = (unet: string, vae: string) => {
    const g = new GraphBuilder();
    const model = g.out("UNETLoader", { unet_name: unet, weight_dtype: "default" });
    const clip = g.out("CLIPLoader", { clip_name: "umt5_xxl.safetensors", type: "wan" });
    const decoder = g.out("VAELoader", { vae_name: vae });
    const text = g.out("CLIPTextEncode", { clip, text: "a cat" });
    const latent = g.out("KSampler", { model, positive: text, negative: text, latent_image: g.out("EmptyLatentImage", { width: 64, height: 64, batch_size: 1 }), seed: 1, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 });
    const saved = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: decoder }) });
    return { graph: g.graph, outputs: [{ node: saved, role: "result" as const, kind: "image" as const }] };
  };
  const held = "umt5_xxl.safetensors|wan_2.1_vae.safetensors|wan2.2_t2v.safetensors";

  it("is kept when only the VAE or text encoder changes: no /free, the render is not cold", () => {
    expect(coldOf(held, graph("wan2.2_t2v.safetensors", "wan_2.1_vae.safetensors"))).toBe(false);
    expect(coldOf(held, graph("wan2.2_t2v.safetensors", "other_vae.safetensors"))).toBe(false);
  });

  it("is let go for another main model, or when nothing is known to be loaded", () => {
    expect(coldOf(held, graph("other_model.safetensors", "wan_2.1_vae.safetensors"))).toBe(true);
    expect(coldOf(null, graph("wan2.2_t2v.safetensors", "wan_2.1_vae.safetensors"))).toBe(true);
  });
});
