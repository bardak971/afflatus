import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@studai/comfy/testing";
import { now } from "../src/db";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const queue = async () => (await get(t.app, "/api/queue")).json();
const ids = async (url: string) => (await get(t.app, url)).json().items.map((a: { id: string }) => a.id);

/** Render one picture with these words; answers with its library id. */
async function picture(prompt: string, over: Record<string, unknown> = {}) {
  const before = fake.prompts.size;
  const id = (await post(t.app, "/api/jobs", job({ prompt, ...over }))).json().ids[0] as string;
  await until(() => fake.prompts.size === before + 1);
  complete(fake, [...fake.prompts.keys()].at(-1)!);
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
  return (await get(t.app, "/api/assets")).json().items[0].id as string;
}

describe("finding things in the library", () => {
  it("searches what was written to make them and their names, forgiving typos, and filters by model and by kept", async () => {
    const terrace = await picture("terrace at sunset, woman holding a cup");
    const market = await picture("street market, rain, neon signs");
    expect(await ids("/api/assets?q=terrace")).toEqual([terrace]);
    expect(await ids("/api/assets?q=neon%20market")).toEqual([market]);
    expect(await ids("/api/assets?q=terace%20sunst")).toEqual([terrace]);
    expect(await ids("/api/assets?q=submarine")).toEqual([]);
    expect((await get(t.app, "/api/assets/families")).json().items).toEqual(["sdxl"]);
    expect(await ids("/api/assets?family=sdxl")).toHaveLength(2);
    expect(await ids("/api/assets?family=h3")).toEqual([]);
    await post(t.app, `/api/assets/${market}/keep`, { kept: true });
    expect(await ids("/api/assets?kept=1")).toEqual([market]);
    expect(await ids("/api/assets?kept=1&q=terrace")).toEqual([]);
  });
});

describe("how long things take", () => {
  it("is learned from past renders and said for what waits", async () => {
    await picture("a cat");
    await t.db.updateTable("generations").set({ gen_ms: 40_000 }).execute();
    expect((await get(t.app, "/api/estimates")).json().rates["sdxl.text-to-picture"]).toMatchObject({ perJobMs: 40_000, perSecondMs: null, samples: 1 });
    await post(t.app, "/api/queue/pause");
    await post(t.app, "/api/jobs", job({ prompt: "a dog" }));
    // the queue keeps what it learned for half a minute: a fresh one reads it now
    const fresh = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    expect((await get(fresh.app, "/api/queue")).json().waiting[0]).toMatchObject({ estimateMs: 40_000 });
    fresh.services.queue.stop();
    await fresh.app.close();
  });
});

describe("the queue, arranged by hand", () => {
  it("runs the waiting jobs in the order they were put in, and new ones after them", async () => {
    await post(t.app, "/api/queue/pause");
    const add = async (prompt: string) => (await post(t.app, "/api/jobs", job({ prompt }))).json().ids[0] as string;
    const [a, b, c] = [await add("a"), await add("b"), await add("c")];
    expect((await queue()).waiting.map((w: { id: string }) => w.id)).toEqual([a, b, c]);
    const ordered = (await post(t.app, "/api/queue/order", { ids: [c, a] })).json();
    expect(ordered.waiting.map((w: { id: string }) => w.id)).toEqual([c, a, b]);
    const d = await add("d");
    expect((await queue()).waiting.map((w: { id: string }) => w.id)).toEqual([c, a, b, d]);
  });

  it("queues a failed job again, with a change when one is asked for, and forgets a finished one", async () => {
    fake.rejectWith = { error: { message: "CUDA out of memory" }, node_errors: {} };
    const id = (await post(t.app, "/api/jobs", job({ prompt: "big", steps: 30 }))).json().ids[0] as string;
    await until(async () => (await queue()).recent[0]?.status === "failed");
    const failed = (await queue()).recent[0];
    expect(failed).toMatchObject({ id, kind: "render", input: { prompt: "big", steps: 30 } });
    fake.rejectWith = null;
    const again = (await post(t.app, `/api/jobs/${id}/retry`, { input: { steps: 12 } })).json().id as string;
    await until(() => fake.prompts.size === 1);
    const sampler = Object.values([...fake.prompts.values()][0]!).find((n) => n.class_type === "KSampler")!;
    expect(sampler.inputs.steps).toBe(12);
    expect((await t.app.inject({ method: "DELETE", url: `/api/jobs/${id}` })).statusCode).toBe(200);
    expect((await queue()).recent.map((r: { id: string }) => r.id)).not.toContain(id);
    // a job that is still running is not one to forget
    expect((await t.app.inject({ method: "DELETE", url: `/api/jobs/${again}` })).statusCode).toBe(404);
  });
});

describe("what is heavy for the card", () => {
  it("is said next to the choice that makes it so, and never refuses anything", async () => {
    const ask = async (input: Record<string, unknown>) => (await post(t.app, "/api/advice", { recipe: "h3.video", input })).json().items;
    // the pretend card has 12 GB
    expect(await ask({ description: "a" })).toEqual([]);
    expect(await ask({ description: "a", short: 768, seconds: 9 })).toEqual([
      { input: "short", level: "heavy", text: "probably too big for a 12 GB card at this length" },
      { input: "seconds", level: "slow", text: expect.stringContaining("two clips that flow on are faster") },
    ]);
    expect(await ask({ description: "a", short: 672 })).toEqual([{ input: "short", level: "slow", text: "slow on your 12 GB card" }]);
    // a form that is not filled in yet, or a recipe with nothing to say: no advice, no error
    expect(await ask({})).toEqual([]);
    expect((await post(t.app, "/api/advice", { recipe: "sdxl.text-to-picture", input: { prompt: "a" } })).json().items).toEqual([]);
  });
});

describe("looking for a missing file on Civitai", () => {
  let asked: Array<{ url: string; auth?: string }>;
  let server: Server;
  beforeEach(async () => {
    asked = [];
    server = createServer((req, res) => {
      asked.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        items: [
          { id: 7, name: "Something close", type: "LORA", modelVersions: [{ name: "v1", baseModel: "SDXL 1.0", trainedWords: ["close"], files: [{ name: "close.safetensors" }] }] },
          { id: 9, name: "Soft Light", type: "LORA", modelVersions: [{ name: "v3" , files: [{ name: "other.safetensors" }] }, { name: "v2", baseModel: "SDXL 1.0", trainedWords: ["softlight"], files: [{ name: "Soft_Light-v2.safetensors" }] }] },
        ],
      }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.CIVITAI_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    delete process.env.CIVITAI_URL;
    await new Promise((r) => server.close(r));
  });

  it("is never done unless it was turned on, then sends the file's name only", async () => {
    const off = await get(t.app, "/api/civitai/find?file=loras/soft_light-v2.safetensors");
    expect(off.statusCode).toBe(400);
    expect(asked).toEqual([]);

    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true, civitaiKey: "k-123" } });
    const found = (await get(t.app, "/api/civitai/find?file=loras/soft_light-v2.safetensors")).json().items;
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("/api/v1/models?query=soft+light+v2&limit=6");
    expect(asked[0]!.auth).toBe("Bearer k-123");
    // the one with a file of exactly this name comes first, with the version that has it
    expect(found[0]).toEqual({ name: "Soft Light", kind: "LORA", url: "https://civitai.com/models/9", version: "v2", base: "SDXL 1.0", words: ["softlight"], exact: true, versionId: null, bytes: 0 });
    expect(found[1]).toMatchObject({ name: "Something close", exact: false });
    // the key never comes back to the browser
    expect((await get(t.app, "/api/settings")).json()).toMatchObject({ civitaiLookups: true, hasCivitaiKey: true });
    expect((await get(t.app, "/api/settings")).body).not.toContain("k-123");
  });
});

describe("where the space goes", () => {
  it("is counted by kind, and the bin can be emptied at once", async () => {
    const a = await picture("one");
    await picture("two");
    let s = (await get(t.app, "/api/storage")).json();
    expect(s).toMatchObject({ total: 66, pictures: 66, videos: 0, bin: { count: 0 }, unkept: { count: 2, bytes: 66 }, idleTakes: { count: 0 } });
    await t.app.inject({ method: "DELETE", url: `/api/assets/${a}` });
    s = (await get(t.app, "/api/storage")).json();
    expect(s).toMatchObject({ pictures: 33, bin: { count: 1, bytes: 33 } });
    expect((await post(t.app, "/api/storage/empty-bin")).json()).toEqual({ erased: 1 });
    expect((await get(t.app, "/api/storage")).json()).toMatchObject({ total: 33, bin: { count: 0 } });
    expect((await get(t.app, `/api/assets/${a}`)).statusCode).toBe(404);
  });
});

/** A short clip with a tone, made with ffmpeg. */
function makeClip(): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "studai-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=192x320:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const clip = makeClip();

describe.skipIf(!clip)("the sound of a video", () => {
  it("can be taken out as a sound of its own", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/assets?name=walk.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip!) });
    const video = res.json();
    const sound = (await post(t.app, `/api/assets/${video.id}/sound`)).json();
    expect(sound).toMatchObject({ kind: "audio", mime: "audio/mp4", name: "walk.mp4, its sound", hasSound: true, kept: true });
    expect(sound.durationMs).toBeGreaterThan(1900);
    // a timeline with two takes of a clip: the one that does not play can be moved to the bin
    const tl = (await post(t.app, "/api/timelines", {})).json();
    const c = (await post(t.app, `/api/timelines/${tl.id}/clips`, { asset: video.id })).json().clip;
    const other = (await t.app.inject({ method: "POST", url: "/api/assets?name=other.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip!) })).json();
    await t.db.insertInto("takes").values({ id: "idle", clip_id: c, asset_id: other.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, created_at: now() }).execute();
    expect((await get(t.app, "/api/storage")).json().idleTakes).toMatchObject({ count: 1 });
    expect((await post(t.app, "/api/storage/bin-idle-takes")).json()).toEqual({ moved: 1 });
    expect((await get(t.app, `/api/timelines/${tl.id}`)).json().clips[0].takes).toHaveLength(1);
    expect((await get(t.app, `/api/assets/${other.id}`)).json().inBin).toBe(true);
    // the first video put on an empty timeline gave it its frame
    expect((await get(t.app, `/api/timelines/${tl.id}`)).json()).toMatchObject({ width: 192, height: 320 });
  });
});
