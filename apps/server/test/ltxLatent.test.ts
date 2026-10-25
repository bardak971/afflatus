import { beforeEach, describe, expect, it } from "vitest";
import { latentClockOf } from "@afflatus/core";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { until } from "./helpers";
import { H3_FILES, timelineSteps, timelineSuite } from "./timelineKit";

/** LTX clips kept and carried on in their own latent (node pack 0.37.0), on a timeline, against a pretend ComfyUI. */

const s = timelineSuite({ ...H3_FILES, checkpoints: ["ltx-2.3-22b-distilled-fp8.safetensors"], text_encoders: [...H3_FILES.text_encoders, "gemma_3_12B_it.safetensors"] });
const { call, view, prompts } = timelineSteps(s);
// the test catalog's checkpoint list holds the picture model's: LTX 2.3's one checkpoint is there too
beforeEach(() => void (s.fake.catalog.CheckpointLoaderSimple!.input.required!.ckpt_name as string[][])[0]!.push("ltx-2.3-22b-distilled-fp8.safetensors"));

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** A saved LTX latent as the node pack writes it: its header says its format, frames, rate and size; the values are zeros. */
function ltxLatentFile(frames: number, width: number, height: number): Uint8Array {
  const shape = [1, 128, (frames - 1) / 8 + 1, height / 32, width / 32];
  const bytes = shape.reduce((p, x) => p * x, 1) * 4;
  const meta = { format: "afflatus-ltx-av-latent/1", frames: String(frames), fps: "25", width: String(width), height: String(height) };
  const header = new TextEncoder().encode(JSON.stringify({ __metadata__: meta, video: { dtype: "F32", shape, data_offsets: [0, bytes] }, audio: { dtype: "F32", shape: [1, 8, frames, 16], data_offsets: [bytes, bytes + frames * 512] } }));
  const out = new Uint8Array(8 + header.length + bytes + frames * 512);
  new DataView(out.buffer).setBigUint64(0, BigInt(header.length), true);
  out.set(header, 8);
  return out;
}

/** The latest prompt finished with this video and, when its graph saves one, the clip's own latent. */
async function finishLtx(count: number, frames: number) {
  const { fake, t, clips } = s;
  await until(() => fake.prompts.size === count, 20_000);
  const [promptId, graph] = prompts().at(-1)! as [string, Graph];
  const out = Object.entries(graph).find(([, n]) => /VideoCombine|SaveVideo/.test(n.class_type))![0];
  const save = Object.entries(graph).find(([, n]) => n.class_type === "AfflatusSaveLTXLatent")?.[0];
  fake.files[`${promptId}.mp4`] = clips.three;
  fake.files[`${promptId}.safetensors`] = ltxLatentFile(frames, 192, 320);
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = {
    status: { completed: true },
    outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] }, ...(save ? { [save]: { latents: [{ filename: `${promptId}.safetensors`, subfolder: "", type: "temp" }] } } : {}) },
  };
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || fake.prompts.size > count, 20_000);
  return graph;
}

const renderLtx = (timeline: string, clip: string) => call("POST", `/api/timelines/${timeline}/render`, { clips: [{ id: clip, input: { prompt: "A lighthouse at dusk, waves below." } }] });

describe.skipIf(!ffmpegThere)("LTX clips carried on in their own latent", { timeout: FFMPEG_TIMEOUT }, () => {
  it("keeps the first clip's latent with its clock, carries the second on in it, decoded as one piece: a seamless join", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test ltx latent" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx.video" })).clip as string;
    await renderLtx(tl.id, a);
    const first = await finishLtx(1, 73);
    expect(Object.values(first).some((n) => n.class_type === "AfflatusSaveLTXLatent")).toBe(true);
    // filed with its clock: LTX 2.3's rate and grid, the latent's size
    const v1 = await view(tl.id);
    const kept = await s.t.db.selectFrom("assets").select(["latent_key", "latent_frames", "latent_clock"]).where("id", "=", v1.clips[0].take.asset.id).executeTakeFirstOrThrow();
    expect(kept.latent_key).toBeTruthy();
    expect(kept.latent_frames).toBe(73);
    expect(latentClockOf(kept.latent_clock)).toEqual({ family: "ltx", fps: 25, grid: { step: 8, offset: 1 }, width: 192, height: 320 });

    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await renderLtx(tl.id, b);
    const second = await finishLtx(2, 145);
    const of = (cls: string) => Object.values(second).filter((n) => n.class_type === cls);
    // the clip before's latent, named where this ComfyUI saved it; its last tokens pinned, the join decoded after them
    expect(of("AfflatusLoadLTXLatent")[0]!.inputs.latent).toMatch(/\.safetensors \[temp\]$/);
    expect(of("AfflatusLTXContinuation")[0]!.inputs.overlap_frames).toBe(25);
    expect(of("LTXVAddLatentGuide")).toHaveLength(1);
    expect(of("AfflatusLTXSeamLatent")).toHaveLength(1);
    // made at the latent's size (in one pass: this ComfyUI has no latent upscaler)
    expect(of("EmptyLTXVLatentVideo")[0]!.inputs).toMatchObject({ width: 192, height: 320 });
    const v2 = await view(tl.id);
    expect(v2.clips[1].take.joinKind).toBe("seamless");
    expect(v2.clips[1].take.seamless).toBe(true);
    expect(v2.clips[1].take.headMs).toBe(1000);
  });

  it("joins on frames after another model's clip, its H3 latent never sent to LTX", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test ltx after h3" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx.video" })).clip as string;
    await renderLtx(tl.id, a);
    await finishLtx(1, 73);
    // the first clip's latent said to be H3's (a latent kept before LTX's were): no LTX recipe continues it
    const v1 = await view(tl.id);
    await s.t.db.updateTable("assets").set({ latent_clock: null }).where("id", "=", v1.clips[0].take.asset.id).execute();
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await renderLtx(tl.id, b);
    const second = await finishLtx(2, 145);
    expect(Object.values(second).some((n) => n.class_type === "AfflatusLoadLTXLatent")).toBe(false);
    expect(s.fake.uploads.filter((u) => u.endsWith(".safetensors"))).toHaveLength(0);
    expect((await view(tl.id)).clips[1].take.joinKind).toBe("carried");
  });
});
