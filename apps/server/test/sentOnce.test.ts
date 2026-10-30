import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { Comfy } from "../src/comfy";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { contentName, sentOnce, type Send } from "../src/queueSubmit";
import { ffmpegMade, FFMPEG_TIMEOUT, ffmpegThere, patternClip, toneFile } from "./clipKit";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Every file a render sends goes up under a name its content gives, once to each machine (card #167): a video, a sound or a
 * cut named afresh each take made ComfyUI load and encode it again (H3's encode of a swap's references, up to 90 s), where
 * the same name lets its cache keep what it made. LoadVideo knows a file by its time on the disk: it is never sent twice.
 */

const H3_REF_FILES = {
  checkpoints: [], upscale_models: [], loras: ["minimax_h3_turbo.safetensors", "minimax_h3_ref2v_turbo.safetensors"],
  diffusion_models: ["minimax_h3_fl2va.safetensors", "minimax_h3_ref2va.safetensors"], text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"],
  vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"],
};
const NAME = /^afflatus_[0-9a-f]{32}\.\w+$/;

describe("a file's name on ComfyUI", () => {
  it("is its content's: the same bytes give the same name, from memory or the disk, other bytes another", async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const name = await contentName(a, "mp4");
    expect(name).toMatch(NAME);
    expect(await contentName(new Uint8Array([1, 2, 3, 4]), "mp4")).toBe(name);
    expect(await contentName(new Blob([a]), "mp4")).toBe(name);
    expect(await contentName(new Uint8Array([1, 2, 3, 5]), "mp4")).not.toBe(name);
    expect(await contentName(a, "wav")).not.toBe(name);
  });
});

describe("a file sent to a machine", () => {
  const machine = () => ({ uploaded: new Map() }) as unknown as Comfy;
  const sender = () => {
    const sent: string[] = [];
    const send: Send = async (_bytes, ext, o) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(o?.name ?? `fresh.${ext}`);
      return `${o?.name} [temp]`;
    };
    return { sent, send };
  };

  it("goes up once when two jobs send it at the same moment, and both name it alike", async () => {
    const comfy = machine();
    const { sent, send } = sender();
    const again: Array<() => Promise<string>> = [];
    const [one, two] = await Promise.all([sentOnce(comfy, new Uint8Array([7, 7]), "mp4", send, again), sentOnce(comfy, new Blob([new Uint8Array([7, 7])]), "mp4", send, again)]);
    expect(one).toBe(two);
    expect(sent).toHaveLength(1);
    // the one taken as there is sent again under the same name if ComfyUI turns out not to have it
    expect(again).toHaveLength(1);
    expect(await again[0]!()).toBe(one);
  });

  it("goes up to each machine, a pod as the PC, under the same name", async () => {
    const [pc, pod] = [machine(), machine()];
    const { sent, send } = sender();
    const bytes = new Uint8Array([9, 8, 7]);
    const here = await sentOnce(pc, bytes, "wav", send, []);
    const there = await sentOnce(pod, bytes, "wav", send, []);
    await sentOnce(pod, bytes, "wav", send, []);
    expect(there).toBe(here);
    expect(sent).toHaveLength(2);
  });
});

describe.skipIf(!ffmpegThere)("a render's videos and sounds", { timeout: FFMPEG_TIMEOUT }, () => {
  let pc: FakeComfy;
  let pod: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    [pc, pod] = await Promise.all([startFakeComfy({ catalog: referenceCatalog(), models: H3_REF_FILES }), startFakeComfy({ catalog: referenceCatalog(), models: H3_REF_FILES })]);
    t = await makeApp({ comfyUrl: pc.url });
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "zz-test PC", url: pc.url }, { id: "m2", name: "zz-test pod", url: pod.url }] } });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await Promise.all([pc.close().catch(() => {}), pod.close().catch(() => {})]);
  });

  const asset = async (kind: "video" | "audio", bytes: Uint8Array, ms: number) => {
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}`;
    await t.services.storage.put(key, bytes);
    await t.db.insertInto("assets").values(newAssetRow({
      id, kind, origin: "uploaded", name: kind === "video" ? "zz-test clip.mp4" : "zz-test voice.wav", file_key: key, thumb_key: null, mime: kind === "video" ? "video/mp4" : "audio/wav", bytes: bytes.length,
      width: kind === "video" ? 320 : null, height: kind === "video" ? 240 : null, duration_ms: ms, fps: kind === "video" ? 24 : null, has_sound: kind === "video" ? 0 : 1, folder_id: null, generation_id: null, kept_at: now(),
    })).execute();
    return id;
  };
  /** A take of H3 with this reference video and voice on that machine, finished: the names its loaders were given. */
  const take = async (fake: FakeComfy, machine: string, video: string, voice: string, description: string) => {
    const n = fake.prompts.size;
    const res = await post(t.app, "/api/jobs", { recipe: "h3.video", machine, input: { description, refVideos: [{ asset: video, role: "person" }], voice, voiceStart: 0, voiceSeconds: 2 } });
    const id = res.json().ids?.[0] as string;
    if (!id) throw new Error(res.body);
    await until(() => fake.prompts.size === n + 1, 30_000);
    const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
    const out = Object.entries(graph).find(([, node]) => /VideoCombine/.test(node.class_type))![0];
    fake.files[`${promptId}.mp4`] = await patternClip(1);
    fake.pending = fake.pending.filter((p) => p !== promptId);
    fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
    await until(async () => ["done", "failed"].includes((await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status), 30_000);
    const loaded = (cls: string, input: string) => Object.values(graph).filter((node) => node.class_type === cls).map((node) => String(node.inputs[input]));
    return { video: loaded("LoadVideo", "file"), sound: loaded("LoadAudio", "audio") };
  };

  it("go up once to each machine under their content's name, and the graph names them so", async () => {
    const video = await asset("video", await patternClip(4), 4000);
    const voice = await asset("audio", await toneFile(3), 3000);
    const first = await take(pc, "m1", video, voice, "A lighthouse.");
    expect(first.video.length).toBeGreaterThan(0);
    expect(first.sound.length).toBeGreaterThan(0);
    for (const name of [...first.video, ...first.sound]) expect(name).toMatch(/^afflatus_[0-9a-f]{32}\.\w+ \[temp\]$/);
    // the same inputs again, another description: the same names, nothing sent again (a second sending would change the
    // file's time on the disk, which LoadVideo's cache goes by)
    const sentBefore = pc.uploads.length;
    const second = await take(pc, "m1", video, voice, "A boat.");
    expect(second).toEqual(first);
    expect(pc.uploads.length).toBe(sentBefore);
    // a pod gets them once too, under the same names
    const onPod = await take(pod, "m2", video, voice, "A harbour.");
    expect(onPod).toEqual(first);
    expect(pod.uploads.length).toBe(sentBefore);
    // another voice: another name
    const other = await asset("audio", await ffmpegMade(["-f", "lavfi", "-i", "sine=frequency=330:duration=3"], "wav"), 3000);
    const third = await take(pc, "m1", video, other, "A boat.");
    expect(third.video).toEqual(first.video);
    expect(third.sound).not.toEqual(first.sound);
  });
});
