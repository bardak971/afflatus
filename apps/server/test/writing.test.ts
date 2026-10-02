import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
import { soundPart } from "../src/cut";
import { now } from "../src/db";
import { checkPrompt, cleanTags } from "../src/tags";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, "other.safetensors"], upscale_models: [], loras: ["film.safetensors", "soft.safetensors"] } });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const put = (url: string, payload: unknown) => t.app.inject({ method: "PUT", url, payload: payload as object });
const textOf = (graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>) =>
  Object.values(graph).filter((n) => n.class_type === "CLIPTextEncode").map((n) => String(n.inputs.text));

describe("choices written in a prompt", () => {
  it("are settled when the job is queued, one for each picture, and what was picked is what is kept", async () => {
    const ids = (await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl, {red|black|white} dress, {smile|}", checkpoint: CHECKPOINT, quality: "" }, count: 4 })).json().ids as string[];
    expect(ids).toHaveLength(4);
    const rows = await t.db.selectFrom("jobs").select("inputs").execute();
    const prompts = rows.map((r) => (JSON.parse(r.inputs) as { prompt: string }).prompt);
    for (const p of prompts) {
      expect(p).toMatch(/^1girl, (red|black|white) dress, (smile)?$/);
      expect(p).not.toMatch(/[{}|]/);
    }
    // the model is sent what was picked
    await until(() => fake.prompts.size === 1);
    expect(textOf([...fake.prompts.values()][0]!).some((x) => prompts.includes(x))).toBe(true);
  });
});

describe("the tag check", () => {
  it("says which tags danbooru does not have, and what to write instead", () => {
    const issues = checkPrompt("1girl, smilling, (grinning:1.2), looking at viewer, masterpiece, zzqqxx thing, <lora:x:1>, a very long plain sentence about nothing at all");
    expect(issues).toEqual([
      { tag: "smilling", status: "unknown", suggestion: expect.any(String) },
      { tag: "(grinning:1.2)", status: "alias", suggestion: "grin" },
      { tag: "zzqqxx thing", status: "unknown" },
    ]);
    // a LoRA's trigger words are not danbooru tags, and are fine
    expect(checkPrompt("1girl, zzqqxx thing", ["zzqqxx thing, other word"])).toEqual([]);
    // choices in braces are looked at as what they can become
    expect(checkPrompt("{red dress|zzqqxx thing}").map((i) => i.tag)).toEqual(["zzqqxx thing"]);
    expect(checkPrompt("1girl, {red|black} dress, {smile|grinning}")).toEqual([{ tag: "grinning", status: "alias", suggestion: "grin" }]);
    // a tag that only exists once a choice is made cannot be swapped with a click: it is only named
    expect(checkPrompt("{smil|grinn}ing")).toEqual([{ tag: "smiling", status: "alias" }, { tag: "grinning", status: "alias" }]);
  });

  it("puts right what is near certain in what a language model wrote, keeping the weight", () => {
    const clean = cleanTags("1girl, (grinning:1.2), zzqqxx thing, long hair");
    expect(clean.tags).toBe("1girl, (grin:1.2), zzqqxx thing, long hair");
    expect(clean.fixed).toEqual([{ from: "(grinning:1.2)", to: "(grin:1.2)" }]);
    expect(clean.unknown).toEqual(["zzqqxx thing"]);
  });

  it("answers over the API, and can be turned off in Settings", async () => {
    const res = (await post(t.app, "/api/tags/check", { text: "1girl, grinning" })).json();
    expect(res.issues).toEqual([{ tag: "grinning", status: "alias", suggestion: "grin" }]);
    expect((await get(t.app, "/api/settings")).json().tagCheck).toBe(true);
    expect((await put("/api/settings", { tagCheck: false })).json().tagCheck).toBe(false);
  });
});

describe("the words that call a LoRA up", () => {
  let asked: string[];
  let server: Server;
  beforeEach(async () => {
    asked = [];
    server = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/by-hash/AB12CD34EF56")) return res.end(JSON.stringify({ id: 77, name: "v4", modelId: 12, trainedWords: ["softlight", " glow style "], model: { name: "Soft Light" } }));
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.CIVITAI_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    delete process.env.CIVITAI_URL;
    await new Promise((r) => server.close(r));
  });
  const kept = (file: string, info: Record<string, unknown>) => t.db.insertInto("model_info").values({ folder: "loras", file, info: JSON.stringify({ ...info, v: 2 }), read_at: now() }).execute();
  const find = async (files: string[]) => (await post(t.app, "/api/models/loras/words/find", { files })).json();

  it("are asked of Civitai by the file's fingerprint, once, and only when looking things up is on", async () => {
    await kept("mine/renamed.safetensors", { fingerprint: "AB12CD34EF56" });
    await kept("unknown.safetensors", { fingerprint: "000000000000" });
    await kept("no_print.safetensors", {});
    expect(await find(["mine/renamed.safetensors"])).toEqual({ items: {}, lookups: false });
    expect(asked).toEqual([]);

    await put("/api/settings", { civitaiLookups: true });
    const found = await find(["mine/renamed.safetensors", "unknown.safetensors", "no_print.safetensors", "not_read_yet.safetensors"]);
    expect(found.items).toEqual({
      "renamed.safetensors": { own: null, found: "softlight, glow style" },
      "unknown.safetensors": { own: null, found: null },
      "no_print.safetensors": { own: null, found: null },
    });
    // by fingerprint only: no name ever leaves, and a file without one is not asked about at all
    expect(asked).toEqual(["/api/v1/model-versions/by-hash/AB12CD34EF56", "/api/v1/model-versions/by-hash/000000000000"]);
    // its page came with the answer
    expect((await get(t.app, "/api/models/loras/pages")).json().items["renamed.safetensors"]).toEqual({ url: "https://civitai.com/models/12?modelVersionId=77", title: "Soft Light · v4" });
    // asked once: the second time nothing goes out
    await find(["mine/renamed.safetensors", "unknown.safetensors"]);
    expect(asked).toHaveLength(2);
  });

  it("can be the user's own, which come first and can be taken away again", async () => {
    expect((await put("/api/models/loras/words", { file: "styles\\Film.safetensors", words: " my film, grainy " })).json().items).toEqual({ "film.safetensors": { own: "my film, grainy", found: null } });
    expect((await get(t.app, "/api/models/loras/words")).json().items).toEqual({ "film.safetensors": { own: "my film, grainy", found: null } });
    expect((await put("/api/models/loras/words", { file: "film.safetensors", words: "" })).json().items["film.safetensors"].own).toBeNull();
  });
});

describe("snippets that are ticked", () => {
  it("are added after what is written, with their category kept, and say so before anything is sent", async () => {
    const pose = (await post(t.app, "/api/entities", { kind: "snippet", name: "Sitting", def: { text: "sitting, crossed legs", category: "Pose", style: "tags" } })).json();
    const light = (await post(t.app, "/api/entities", { kind: "snippet", name: "Evening", def: { text: "{sunset|golden hour}, long shadows" } })).json();
    expect(pose.def).toEqual({ text: "sitting, crossed legs", category: "Pose", style: "tags" });
    expect(light.def).toEqual({ text: "{sunset|golden hour}, long shadows", category: "", style: null });

    const look = { cast: [], snippets: [pose.id, light.id] };
    const made = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl, terrace" }, look })).json();
    expect(made.input.prompt).toBe("1girl, terrace, sitting, crossed legs, {sunset|golden hour}, long shadows");
    expect(made.added.words).toEqual([{ from: "Sitting", text: "sitting, crossed legs" }, { from: "Evening", text: "{sunset|golden hour}, long shadows" }]);

    // queued: the snippets are in, and the choice inside one is settled
    await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl, terrace", checkpoint: CHECKPOINT, quality: "" }, look });
    const job = JSON.parse((await t.db.selectFrom("jobs").select("inputs").executeTakeFirstOrThrow()).inputs) as { prompt: string };
    expect(job.prompt).toMatch(/^1girl, terrace, sitting, crossed legs, (sunset|golden hour), long shadows$/);
    await until(() => fake.prompts.size === 1);
  });
});

describe("the library by checkpoint and by LoRA", () => {
  it("lists what things were made with, the most used first, and shows only those", async () => {
    const make = async (checkpoint: string, loras: Array<{ file: string; weight: number }>) => {
      const before = fake.prompts.size;
      await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl", checkpoint, loras } });
      await until(() => fake.prompts.size === before + 1);
      complete(fake, [...fake.prompts.keys()].at(-1)!);
      await until(async () => (await get(t.app, "/api/queue")).json().running === null && (await get(t.app, "/api/queue")).json().waiting.length === 0);
    };
    await make(CHECKPOINT, [{ file: "film.safetensors", weight: 0.8 }]);
    await make(CHECKPOINT, [{ file: "film.safetensors", weight: 0.5 }, { file: "soft.safetensors", weight: 0.6 }]);
    await make("other.safetensors", [{ file: "soft.safetensors", weight: 0 }]);

    expect((await get(t.app, "/api/assets/models")).json()).toEqual({
      models: [{ file: CHECKPOINT, count: 2 }, { file: "other.safetensors", count: 1 }],
      // a LoRA set to 0 was not used
      loras: [{ file: "film.safetensors", count: 2 }, { file: "soft.safetensors", count: 1 }],
    });
    const count = async (query: string) => (await get(t.app, `/api/assets?${query}`)).json().items.length;
    expect(await count("")).toBe(3);
    expect(await count(`model=${CHECKPOINT}`)).toBe(2);
    expect(await count("model=other.safetensors")).toBe(1);
    expect(await count("lora=film.safetensors")).toBe(2);
    expect(await count("lora=soft.safetensors")).toBe(1);
    expect(await count(`model=${CHECKPOINT}&lora=soft.safetensors`)).toBe(1);
    expect(await count("model=other.safetensors&lora=film.safetensors")).toBe(0);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
describe.skipIf(!hasFfmpeg)("a part of a sound", () => {
  const tone = (seconds: number) => {
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
    return new Uint8Array(made.stdout);
  };
  /** How long a 48 kHz stereo 16-bit WAV is, from its size. */
  const secondsOf = (wav: Uint8Array) => (wav.length - 44) / (48000 * 2 * 2);

  it("is cut where it is asked, as long as asked", async () => {
    const part = await soundPart(tone(10), "wav", { start: 3, seconds: 4, durationMs: 10_000 });
    expect(secondsOf(part)).toBeCloseTo(4, 1);
  });

  it("starts where it is asked as long as two seconds are left, and ends where the sound ends", async () => {
    // 4 s asked from 7 s of a 10 s sound: the 3 s that are left
    expect(secondsOf(await soundPart(tone(10), "wav", { start: 7, seconds: 4, durationMs: 10_000 }))).toBeCloseTo(3, 1);
    // a start too close to the end is brought back to two seconds before it
    expect(secondsOf(await soundPart(tone(10), "wav", { start: 9.5, seconds: 4, durationMs: 10_000 }))).toBeCloseTo(2, 1);
    // a sound shorter than the part: all of it
    expect(secondsOf(await soundPart(tone(3), "wav", { start: 0, seconds: 8, durationMs: 3_000 }))).toBeCloseTo(3, 1);
  });
});

describe("what a draft made, and where it lands", () => {
  it("is filed in the folder that was open when it was sent, without being kept, and is found by its draft", async () => {
    const folder = (await post(t.app, "/api/folders", { name: "Terrace" })).json();
    const draft = (await post(t.app, "/api/drafts", { recipe: "sdxl.text-to-picture" })).json();
    const make = async (extra: Record<string, unknown>) => {
      const before = fake.prompts.size;
      await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl", checkpoint: CHECKPOINT }, ...extra });
      await until(() => fake.prompts.size === before + 1);
      // while it renders, the queue says which draft it is from
      const running = (await get(t.app, "/api/queue")).json().running;
      complete(fake, [...fake.prompts.keys()].at(-1)!);
      await until(async () => (await get(t.app, "/api/queue")).json().running === null);
      return running;
    };
    expect((await make({ draft: draft.id, folder: folder.id })).draftId).toBe(draft.id);
    expect((await make({})).draftId).toBeNull();
    // a folder that is gone by the time it is done: the result is not filed
    await make({ draft: draft.id, folder: "no-such-folder" });

    const all = (await get(t.app, "/api/assets")).json().items;
    expect(all).toHaveLength(3);
    const mine = (await get(t.app, `/api/assets?draft=${draft.id}`)).json().items;
    expect(mine).toHaveLength(2);
    const filed = (await get(t.app, `/api/assets?folder=${folder.id}`)).json().items;
    expect(filed).toHaveLength(1);
    // in a folder, and still on its one-day countdown
    expect(filed[0].kept).toBe(false);
    expect(mine.map((a: { id: string }) => a.id)).toContain(filed[0].id);
  });
});
