import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@studai/comfy/testing";
import { now } from "../src/db";
import { forgetHuggingFace } from "../src/huggingface";
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
    // what was rendered before each render was put on record still answers, where there is no record
    await t.db.deleteFrom("render_stats").execute();
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
      // one version is known by the fingerprint of its file
      if (req.url?.startsWith("/api/v1/model-versions/by-hash/")) {
        if (req.url.endsWith("/AB12CD34EF56")) return res.end(JSON.stringify({ id: 77, name: "v4", modelId: 12, model: { name: "Its real name" } }));
        res.writeHead(404);
        return res.end("{}");
      }
      res.end(JSON.stringify({
        items: [
          { id: 5, name: "Soft light workflow", type: "Workflows", modelVersions: [{ name: "v1", files: [{ name: "soft light v2.json" }] }] },
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
    const answer = (await get(t.app, "/api/civitai/find?file=loras/soft_light-v2.safetensors&folder=loras")).json();
    const found = answer.items;
    expect(asked).toHaveLength(1);
    // everything is asked for, mature models included, and only the kind the folder holds
    expect(asked[0]!.url).toBe("/api/v1/models?query=soft+light+v2&limit=20&nsfw=true&types=LORA&types=LoCon&types=DoRA");
    expect(asked[0]!.auth).toBe("Bearer k-123");
    // the one with a file of exactly this name comes first, with the version that has it
    expect(found[0]).toMatchObject({
      name: "Soft Light", kind: "LORA", url: "https://civitai.com/models/9", version: "v2", base: "SDXL 1.0", words: ["softlight"],
      exact: true, fits: true, file: "Soft_Light-v2.safetensors", hits: ["soft", "light", "v2"], of: 3,
    });
    expect(found[1]).toMatchObject({ name: "Something close", exact: false, fits: true, hits: [] });
    // a workflow found by the same words is not a LoRA: it is left out
    expect(found.map((f: { name: string }) => f.name)).toEqual(["Soft Light", "Something close"]);
    // the key never comes back to the browser
    expect((await get(t.app, "/api/settings")).json()).toMatchObject({ civitaiLookups: true, hasCivitaiKey: true });
    expect((await get(t.app, "/api/settings")).body).not.toContain("k-123");
  });

  it("finds the page a LoRA came from by its name, remembers it, and takes the user's word when the name does not settle it", async () => {
    const find = async (file: string) => (await post(t.app, "/api/models/loras/page", { file })).json();
    const pages = async () => (await get(t.app, "/api/models/loras/pages")).json().items;
    const say = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/models/loras/page", payload: payload as object });

    // not turned on: nothing is asked, and the answer says why
    expect(await find("styles\\Soft_Light-v2.safetensors")).toEqual({ page: null, candidates: [], lookups: false });
    expect(asked).toEqual([]);

    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
    // a model with a file of exactly this name is its page: remembered under the file's name, whatever its sub-folder
    expect(await find("styles\\Soft_Light-v2.safetensors")).toEqual({ page: { url: "https://civitai.com/models/9", title: "Soft Light · v2" }, candidates: [], lookups: true });
    expect(await pages()).toEqual({ "soft_light-v2.safetensors": { url: "https://civitai.com/models/9", title: "Soft Light · v2" } });
    const before = asked.length;
    expect((await find("Soft_Light-v2.safetensors")).page.url).toBe("https://civitai.com/models/9");
    expect(asked).toHaveLength(before);

    // no file of that name anywhere: the closest are offered, nothing is remembered until one is picked
    const unsure = await find("mystery_style.safetensors");
    expect(unsure.page).toBeNull();
    // (the site named is the pretend one of this test; the pages themselves are on the real one)
    expect(unsure.candidates.map((c: { title: string; url: string; about: string }) => [c.title, c.url, c.about])).toEqual([["Something close · v1", "https://civitai.com/models/7", "LORA · SDXL 1.0"], ["Soft Light · v3", "https://civitai.com/models/9", "LORA"]]);
    expect(Object.keys(await pages())).toEqual(["soft_light-v2.safetensors"]);
    expect((await say({ file: "mystery_style.safetensors", url: "https://civitai.red/models/7", title: "Something close · v1" })).json()).toEqual({ page: { url: "https://civitai.red/models/7", title: "Something close · v1" } });
    expect((await find("other\\Mystery_Style.safetensors")).page.url).toBe("https://civitai.red/models/7");
    // an address of the user's own, then "that is not its page"
    expect((await say({ file: "mystery_style.safetensors", url: "https://huggingface.co/someone/mystery" })).json().page).toEqual({ url: "https://huggingface.co/someone/mystery", title: "huggingface.co" });
    expect((await say({ file: "mystery_style.safetensors", url: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await say({ file: "mystery_style.safetensors", url: null })).json()).toEqual({ page: null });
    expect(Object.keys(await pages())).toEqual(["soft_light-v2.safetensors"]);
  });

  it("finds a renamed LoRA by its fingerprint: the name is not needed, and not asked about", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
    const kept = (file: string, print: string) => t.db.insertInto("model_info").values({ folder: "loras", file, info: JSON.stringify({ fingerprint: print, v: 2 }), read_at: new Date().toISOString() }).execute();
    await kept("mine/renamed_by_me.safetensors", "AB12CD34EF56");
    await kept("unknown_there.safetensors", "000000000000");
    const find = async (file: string) => (await post(t.app, "/api/models/loras/page", { file })).json();

    expect(await find("mine/renamed_by_me.safetensors")).toEqual({ page: { url: "https://civitai.com/models/12?modelVersionId=77", title: "Its real name · v4" }, candidates: [], lookups: true });
    expect(asked.map((a) => a.url)).toEqual(["/api/v1/model-versions/by-hash/AB12CD34EF56"]);
    // a fingerprint Civitai does not know: the name is tried, as before
    const other = await find("unknown_there.safetensors");
    expect(other.page).toBeNull();
    expect(other.candidates.length).toBeGreaterThan(0);
    expect(asked.map((a) => a.url.split("?")[0])).toEqual(["/api/v1/model-versions/by-hash/AB12CD34EF56", "/api/v1/model-versions/by-hash/000000000000", "/api/v1/models"]);
  });
});

describe("looking for a missing file on Hugging Face", () => {
  let asked: string[];
  let server: Server;
  beforeEach(async () => {
    asked = [];
    forgetHuggingFace();
    server = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/v1/models") return res.end(JSON.stringify({ items: [] }));
      // ComfyUI's own repositories, then what a search by words finds
      if (url.searchParams.get("author") === "Comfy-Org") {
        return res.end(JSON.stringify([
          { id: "Comfy-Org/Some-Model", downloads: 5000, siblings: [{ rfilename: "text_encoders/reader_4b_fp8_scaled.safetensors" }, { rfilename: "vae/its_vae.safetensors" }] },
        ]));
      }
      res.end(JSON.stringify([
        { id: "someone/a-copy", downloads: 90000, siblings: [{ rfilename: "READER_4b_fp8_scaled.safetensors" }] },
        { id: "someone/close-but-not-it", downloads: 1e6, siblings: [{ rfilename: "reader_4b_int8.safetensors" }] },
        { id: "locked/behind-terms", downloads: 10, gated: "manual", siblings: [{ rfilename: "reader_4b_fp8_scaled.safetensors" }] },
      ]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.CIVITAI_URL = at;
    process.env.HUGGINGFACE_URL = at;
  });
  afterEach(async () => {
    delete process.env.CIVITAI_URL;
    delete process.env.HUGGINGFACE_URL;
    await new Promise((r) => server.close(r));
  });

  it("finds the file by its exact name only, ComfyUI's own repository first, with the address to fetch it from", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
    const answer = (await get(t.app, "/api/civitai/find?file=reader_4b_fp8_scaled.safetensors&folder=text_encoders&hints=Some%20Model")).json();
    expect(answer.exact.map((h: { repo: string }) => h.repo)).toEqual(["Comfy-Org/Some-Model", "someone/a-copy", "locked/behind-terms"]);
    expect(answer.exact[0]).toMatchObject({ path: "text_encoders/reader_4b_fp8_scaled.safetensors", downloads: 5000, gated: false });
    expect(answer.exact[0].url).toMatch(/\/Comfy-Org\/Some-Model\/resolve\/main\/text_encoders\/reader_4b_fp8_scaled\.safetensors$/);
    expect(answer.exact[2]).toMatchObject({ gated: true });
    expect(answer.asked).toContain("huggingface.co");
    // what was sent: the first words of the name, and the word that says which model it is for
    const searched = asked.filter((u) => u.startsWith("/api/models") && u.includes("search=")).map((u) => new URL(u, "http://x").searchParams.get("search"));
    expect(searched).toEqual(["reader 4b", "reader", "some model"]);
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
