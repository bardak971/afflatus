import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { now } from "../src/db";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: referenceCatalog(),
    models: {
      checkpoints: [CHECKPOINT], upscale_models: [], loras: ["her_illustrious.safetensors", "film.safetensors", "minimax_h3_turbo.safetensors", "minimax_h3_ref2v_turbo.safetensors"],
      diffusion_models: ["minimax_h3_fl2va.safetensors", "minimax_h3_ref2va.safetensors"], text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"],
      vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const put = async (url: string, payload: unknown) => (await t.app.inject({ method: "PUT", url, payload: payload as object })).json();
const picture = async (name: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id as string;
/** A sound in the library, without needing ffmpeg to read one. */
async function sound(name: string) {
  const at = now();
  await t.db
    .insertInto("assets")
    .values({ id: name, owner_id: "local", kind: "audio", origin: "uploaded", name, file_key: `assets/${name}.wav`, thumb_key: null, mime: "audio/wav", bytes: 4, width: null, height: null, duration_ms: 8000, fps: null, has_sound: 1, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at })
    .execute();
  await t.services.storage.put(`assets/${name}.wav`, new Uint8Array([1, 2, 3, 4]));
  return name;
}

/** Her: two pictures, a voice, words both ways, a LoRA for SDXL, a summer dress. A terrace. A film look. */
async function cast() {
  const [front, side, dress, terrace] = [await picture("front.png"), await picture("side.png"), await picture("dress.png"), await picture("terrace.png")];
  const voice = await sound("voice");
  const her = (await post(t.app, "/api/entities", { kind: "person", name: "Her" })).json();
  await put(`/api/entities/${her.id}`, {
    def: {
      pictures: [front, side], voice, tags: "brown hair, green eyes", sentence: "She has brown hair and green eyes.",
      models: { sdxl: { lora: "her_illustrious.safetensors", weight: 0.7, trigger: "her_character" } },
      outfits: [{ id: "dress", name: "Summer dress", tags: "white summer dress", sentence: "She wears a white summer dress.", picture: dress }],
    },
  });
  const place = (await post(t.app, "/api/entities", { kind: "place", name: "The terrace", def: { pictures: [terrace], tags: "terrace, bay", sentence: "A terrace above a bay." } })).json();
  const style = (await post(t.app, "/api/entities", { kind: "style", name: "Film look", def: { models: { sdxl: { loras: [{ file: "film.safetensors", weight: 0.5 }], words: "film grain" }, h3: { loras: [], words: "Shot on film, warm light." } } } })).json();
  return { her: her.id as string, place: place.id as string, style: style.id as string, front, side, dress, terrace, voice };
}

describe("people, places and styles", () => {
  it("are kept with what each kind holds, and what is used by them is kept in the library", async () => {
    const c = await cast();
    // the presets that ship with Afflatus are listed too: here, only the user's own
    const items = (await get(t.app, "/api/entities")).json().items.filter((e: { source?: string }) => !e.source);
    expect(items.map((e: { kind: string; name: string }) => [e.kind, e.name])).toEqual([["style", "Film look"], ["person", "Her"], ["place", "The terrace"]]);
    expect((await get(t.app, "/api/entities?kind=person")).json().items[0].def).toMatchObject({ voice: c.voice, outfits: [{ name: "Summer dress" }], models: { sdxl: { trigger: "her_character" } } });
    // a field that a kind does not have is refused
    expect((await t.app.inject({ method: "PUT", url: `/api/entities/${c.place}`, payload: { def: { voice: "x" } } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "DELETE", url: `/api/entities/${c.place}` })).statusCode).toBe(200);
    expect((await get(t.app, "/api/entities")).json().items.filter((e: { source?: string }) => !e.source)).toHaveLength(2);
  });

  it("keep a made picture they are given from the start, not only when changed", async () => {
    const at = now();
    await t.db
      .insertInto("assets")
      .values({ id: "made", owner_id: "local", kind: "image", origin: "generated", name: "made", file_key: "assets/made.png", thumb_key: null, mime: "image/png", bytes: 4, width: 64, height: 96, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: at })
      .execute();
    await post(t.app, "/api/entities", { kind: "place", name: "The bay", def: { pictures: ["made"], tags: "bay", sentence: "A bay." } });
    expect((await t.db.selectFrom("assets").select("kept_at").where("id", "=", "made").executeTakeFirstOrThrow()).kept_at).not.toBeNull();
  });

  it("become tags and LoRAs for a model that reads tags", async () => {
    const c = await cast();
    const look = { cast: [{ id: c.her, outfit: "dress" }, { id: c.place }], style: c.style };
    const made = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: { prompt: "holding a cup", checkpoint: CHECKPOINT }, look })).json();
    expect(made.input.prompt).toBe("her_character, brown hair, green eyes, white summer dress, holding a cup, terrace, bay, film grain");
    expect(made.input.loras).toEqual([{ file: "her_illustrious.safetensors", weight: 0.7 }, { file: "film.safetensors", weight: 0.5 }]);
    expect(made.added).toMatchObject({ references: 0, voice: null, loras: [{ from: "Her" }, { from: "Film look" }] });

    // a job with a look is queued as what it became
    await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "holding a cup", checkpoint: CHECKPOINT }, look });
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    expect(Object.values(graph).filter((n) => n.class_type === "LoraLoader").map((n) => n.inputs.lora_name)).toEqual(["her_illustrious.safetensors", "film.safetensors"]);
    expect(Object.values(graph).some((n) => String(n.inputs.text ?? "").startsWith("her_character, brown hair"))).toBe(true);
  });

  it("are worked into the job, while what was typed is kept beside what it became, for a tool to carry on with", async () => {
    const c = await cast();
    const look = { cast: [{ id: c.her, outfit: "dress" }], style: c.style };
    const { ids } = (await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "{holding|drinking from} a cup", checkpoint: CHECKPOINT }, look, count: 2 })).json();
    // one at a time: each is finished as it comes
    for (const n of [1, 2]) {
      await until(() => fake.prompts.size === n);
      complete(fake, [...fake.prompts.keys()][n - 1]!);
    }
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "in", ids).execute()).every((j) => j.status === "done"));
    const jobs = await t.db.selectFrom("jobs").select(["id", "inputs", "asked"]).where("id", "in", ids).execute();
    for (const j of jobs) {
      const inputs = JSON.parse(j.inputs);
      const asked = JSON.parse(j.asked!);
      // each copy's choice is settled once: what was asked and what renders pick the same
      expect(["holding a cup", "drinking from a cup"]).toContain(asked.prompt);
      expect(inputs.prompt).toBe(`her_character, brown hair, green eyes, white summer dress, ${asked.prompt}, film grain`);
      expect(inputs.loras).toHaveLength(2);
      expect(asked.loras ?? []).toEqual([]);
      expect(asked.checkpoint).toBe(CHECKPOINT);
    }
    // filed with what it made: the asset's generation says both
    const { items } = (await get(t.app, "/api/assets")).json();
    const detail = (await get(t.app, `/api/assets/${items[0].id}`)).json();
    expect(detail.generation.inputs.prompt).toContain("her_character");
    expect(detail.generation.asked.prompt).toMatch(/^(holding|drinking from) a cup$/);
    expect(detail.look).toMatchObject({ cast: [{ id: c.her }] });

    // without a cast nothing is kept beside it
    await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "a dog", checkpoint: CHECKPOINT } });
    await until(() => fake.prompts.size === 3);
    expect((await t.db.selectFrom("jobs").select("asked").orderBy("created_at", "desc").limit(1).executeTakeFirstOrThrow()).asked).toBeNull();
  });

  it("become reference pictures, a voice and sentences for a model that follows references", async () => {
    const c = await cast();
    const look = { cast: [{ id: c.her, outfit: "dress" }, { id: c.place }], style: c.style };
    const made = (await post(t.app, "/api/compose", { recipe: "h3.video", input: { description: "She waves at a boat." }, look })).json();
    expect(made.input.references).toEqual([
      { asset: c.front, role: "person" }, { asset: c.side, role: "person" }, { asset: c.dress, role: "clothing" }, { asset: c.terrace, role: "place" },
    ]);
    expect(made.input.voice).toBe(c.voice);
    // how she looks goes where the recipe asks for it; the place and the look go around what happens
    expect(made.input.subject).toBe("She has brown hair and green eyes. She wears a white summer dress.");
    expect(made.input.description).toBe("A terrace above a bay. She waves at a boat. Shot on film, warm light.");
    expect(made.added).toMatchObject({ references: 4, voice: "Her" });
    // and whose each one is, for the form to show them in the reference field
    expect(made.added.refs).toEqual([
      { asset: c.front, role: "person", from: "Her" }, { asset: c.side, role: "person", from: "Her" }, { asset: c.dress, role: "clothing", from: "Her" }, { asset: c.terrace, role: "place", from: "The terrace" },
    ]);

    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "She waves at a boat." }, look });
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    const node = Object.values(graph).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(Object.keys(node.inputs).filter((k) => k.startsWith("ref_images."))).toHaveLength(4);
    expect(node.inputs["ref_audios.ref_audio_0"]).toBeDefined();
    expect(String(node.inputs.prompt)).toContain("<Subject 1> is the character in <Picture 1> and <Picture 2>, She has brown hair and green eyes. She wears a white summer dress.");
    expect(Object.values(graph).find((n) => n.class_type === "UNETLoader")!.inputs.unet_name).toBe("minimax_h3_ref2va.safetensors");
    expect(fake.uploads.filter((u) => u.endsWith(".png"))).toHaveLength(4);
    expect(fake.uploads.filter((u) => u.endsWith(".wav"))).toHaveLength(1);
  });

  it("say what did not fit, and leave out what is gone", async () => {
    const c = await cast();
    // the library refuses to bin a picture a person still names (409); one gone all the same (a database from before) is left out
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${c.side}` })).statusCode).toBe(409);
    await t.db.updateTable("assets").set({ deleted_at: new Date().toISOString() }).where("id", "=", c.side).execute();
    const made = (await post(t.app, "/api/compose", { recipe: "h3.video", input: { description: "x", voice: "mine" }, look: { cast: [{ id: c.her }], style: c.style } })).json();
    expect(made.input.references).toEqual([{ asset: c.front, role: "person" }]);
    // a voice that was chosen by hand stays
    expect(made.input.voice).toBe("mine");
    const wan = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: { prompt: "x", checkpoint: CHECKPOINT }, look: { cast: [], style: c.style } })).json();
    expect(wan.added.skipped).toEqual([]);
    const none = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: { prompt: "x", checkpoint: CHECKPOINT }, look: { cast: [], style: null } })).json();
    expect(none.input).toEqual({ prompt: "x", checkpoint: CHECKPOINT });
  });

  it("are set once for a timeline and used by every clip, unless a clip has its own", async () => {
    const c = await cast();
    const tl = (await post(t.app, "/api/timelines", {})).json();
    const patch = async (url: string, payload: unknown) => t.app.inject({ method: "PATCH", url, payload: payload as object });
    await patch(`/api/timelines/${tl.id}`, { look: { cast: [{ id: c.her }], style: null } });
    const a = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip;
    await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: a, input: { description: "She waves." } }] });
    await until(() => fake.prompts.size === 1);
    expect(Object.values([...fake.prompts.values()][0]!).some((n) => n.class_type === "MiniMaxH3ReferenceToVideo")).toBe(true);

    // one render at a time: the first is stopped so that the next one is sent
    await post(t.app, `/api/jobs/${(await get(t.app, "/api/queue")).json().running.id}/cancel`);
    await until(async () => (await get(t.app, "/api/queue")).json().running === null);

    await patch(`/api/clips/${a}`, { look: { cast: [], style: null } });
    expect((await get(t.app, `/api/timelines/${tl.id}`)).json()).toMatchObject({ look: { cast: [{ id: c.her }] }, clips: [{ look: { cast: [] } }] });
    await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: a, input: { description: "The sea." } }] });
    await until(() => fake.prompts.size === 2);
    expect(Object.values([...fake.prompts.values()][1]!).some((n) => n.class_type === "MiniMaxH3ImageToVideo")).toBe(true);
  });

  it("are remembered with a draft", async () => {
    const c = await cast();
    const d = (await post(t.app, "/api/drafts", { recipe: "h3.video", look: { cast: [{ id: c.her, outfit: "dress" }], style: c.style } })).json();
    expect(d.look).toEqual({ cast: [{ id: c.her, outfit: "dress" }], style: c.style, snippets: [] });
    expect((await put(`/api/drafts/${d.id}`, { look: null })).look).toBeNull();
  });
});

describe("pictures uploaded for the Prompt kit", () => {
  it("are kept with the person, not shown in the library, and go to the bin once no one names them", async () => {
    const kit = (await t.app.inject({ method: "POST", url: "/api/assets?name=face.png&as=kit", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id as string;
    const mine = await picture("mine.png");
    const listed = async () => ((await get(t.app, "/api/assets?kind=image")).json().items as Array<{ id: string }>).map((x) => x.id);
    expect(await listed()).toEqual([mine]);
    const her = (await post(t.app, "/api/entities", { kind: "person", name: "Her" })).json();
    await put(`/api/entities/${her.id}`, { def: { pictures: [kit, mine] } });
    // the person's pictures work as references all the same
    const made = (await post(t.app, "/api/compose", { recipe: "h3.video", input: { description: "a" }, look: { cast: [{ id: her.id }] } })).json();
    expect(made.added.refs.map((r: { asset: string }) => r.asset)).toEqual([kit, mine]);
    // taken off her: the uploaded one goes to the bin, the library's own stays where it is
    await put(`/api/entities/${her.id}`, { def: { pictures: [mine] } });
    const gone = await t.db.selectFrom("assets").select(["id", "deleted_at"]).where("id", "in", [kit, mine]).execute();
    expect(gone.find((x) => x.id === kit)?.deleted_at).not.toBeNull();
    expect(gone.find((x) => x.id === mine)?.deleted_at).toBeNull();
  });
});

describe("presets", () => {
  it("may name no model, hold nothing yet, and set only what they say", async () => {
    // started empty from the Prompt kit: no model, no parameters
    const empty = await post(t.app, "/api/entities", { kind: "preset", name: "New preset" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().def).toEqual({ inputs: {} });
    // a prompt for any model
    const words = await post(t.app, "/api/entities", { kind: "preset", name: "Film words", def: { inputs: { prompt: "35mm film still" } } });
    expect(words.statusCode).toBe(200);
    expect(words.json().def).toEqual({ inputs: { prompt: "35mm film still" } });
    // a model and part of its form
    const some = await post(t.app, "/api/entities", { kind: "preset", name: "Soft light", def: { recipe: "sdxl.text-to-picture", inputs: { steps: 32, cfg: 4.5 }, look: { cast: [], style: null, snippets: [] } } });
    expect(some.statusCode).toBe(200);
    expect(some.json().def).toMatchObject({ recipe: "sdxl.text-to-picture", inputs: { steps: 32, cfg: 4.5 } });
    const changed = await put(`/api/entities/${some.json().id}`, { def: { recipe: "sdxl.text-to-picture", inputs: { steps: 32 } } });
    expect(changed.def.inputs).toEqual({ steps: 32 });
  });

  it("hold a look of the shape a draft holds, or none: any other is refused, so that applying one never breaks the draft", async () => {
    const bad = async (look: unknown) => (await post(t.app, "/api/entities", { kind: "preset", name: "Bad", def: { inputs: {}, look } })).statusCode;
    expect(await bad({ cast: "her" })).toBe(400);
    expect(await bad({ cast: [], style: null, snippets: [], extra: 1 })).toBe(400);
    expect(await bad({ cast: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}` })) })).toBe(400);
    expect(await bad(null)).toBe(200);
  });
});

describe("a form composed twice", () => {
  it("gets its cast's words once: a tool opened on a picture made with them keeps them as they are", async () => {
    const c = await cast();
    const look = { cast: [{ id: c.her, outfit: "dress" }, { id: c.place }], style: c.style };
    const once = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: { prompt: "holding a cup", checkpoint: CHECKPOINT }, look })).json();
    const twice = (await post(t.app, "/api/compose", { recipe: "sdxl.text-to-picture", input: once.input, look })).json();
    expect(twice.input.prompt).toBe(once.input.prompt);
    expect(twice.input.loras).toEqual(once.input.loras);
    // in sentences, and in the subject a reference model keeps for how the people look
    const first = (await post(t.app, "/api/compose", { recipe: "h3.video", input: { description: "She waves at a boat." }, look })).json();
    const again = (await post(t.app, "/api/compose", { recipe: "h3.video", input: first.input, look })).json();
    expect(again.input.description).toBe(first.input.description);
    expect(again.input.subject).toBe(first.input.subject);
    expect(again.input.references).toEqual(first.input.references);
  });
});

describe("the kinds listed", () => {
  it("are the kinds there are: another is refused", async () => {
    expect((await get(t.app, "/api/entities?kind=person")).statusCode).toBe(200);
    expect((await get(t.app, "/api/entities?kind=robot")).statusCode).toBe(400);
  });
});
