import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { now } from "../src/db";
import { CHECKPOINT, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

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
    await t.app.inject({ method: "DELETE", url: `/api/assets/${c.side}` });
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
});
