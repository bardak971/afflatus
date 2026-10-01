import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
import { CHECKPOINT, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/** A stand-in for a language model's address: it answers what the test tells it to, and keeps what it was asked. */
interface FakeLlm {
  url: string;
  asked: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; auth: string | undefined }>;
  answers: string[];
  close(): Promise<void>;
}
async function startFakeLlm(): Promise<FakeLlm> {
  const llm: Omit<FakeLlm, "url" | "close"> = { asked: [], answers: [] };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { model: string; messages: FakeLlm["asked"][number]["messages"] };
    llm.asked.push({ model: body.model, messages: body.messages, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: llm.answers.shift() ?? "kind: proposal\nnote: nothing" } }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(llm, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

let fake: FakeComfy;
let llm: FakeLlm;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: referenceCatalog(),
    models: { checkpoints: [CHECKPOINT], upscale_models: [], loras: [], diffusion_models: ["minimax_h3_fl2va.safetensors"], text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"], vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"] },
  });
  llm = await startFakeLlm();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
  await llm.close();
});

const put = async (url: string, payload: unknown) => t.app.inject({ method: "PUT", url, payload: payload as object });
const useLlm = (over: Record<string, unknown> = {}) => put("/api/settings", { llm: { baseUrl: llm.url, model: "test-model", apiKey: "secret", ...over } });
const system = (n = -1) => String(llm.asked.at(n)!.messages[0]!.content);

describe("the designer's language model", () => {
  it("is asked for in Setup, and its key is never handed back nor lost", async () => {
    expect((await post(t.app, "/api/designer/test")).json().error).toMatch(/no language model yet/);
    expect((await useLlm()).json().llm).toEqual({ baseUrl: llm.url, model: "test-model", hasApiKey: true, vision: false });
    // the address changes; the key is not sent again and stays
    await put("/api/settings", { llm: { vision: true } });
    llm.answers.push("ready");
    expect((await post(t.app, "/api/designer/test")).json()).toEqual({ ok: true, model: "test-model", answer: "ready" });
    expect(llm.asked[0]).toMatchObject({ model: "test-model", auth: "Bearer secret" });
    expect((await get(t.app, "/api/settings")).json().llm).toMatchObject({ hasApiKey: true, vision: true });
  });
});

describe("a conversation with the designer", () => {
  it("knows how the model's prompts are written and what is written now, and answers with the full text of what it changes", async () => {
    await useLlm();
    llm.answers.push(`kind: proposal
note: I made the light warmer.
description: She waves at the boat, the low sun warm on her face. (S1) says <d>[English] Hello!</d> brightly.
soundscape: waves, a light wind
music: (empty)
options: even warmer | add seagulls | "the camera pushes in"`);
    const reply = (await post(t.app, "/api/designer", {
      recipe: "h3.video", values: { description: "She waves at the boat.", soundscape: "waves", seconds: 6 },
      messages: [{ role: "user", content: "make the light warmer" }], previous: "She walks to the railing.", mood: "calm, film grain",
    })).json();
    expect(reply).toMatchObject({
      kind: "proposal", note: "I made the light warmer.", sawPicture: false,
      changes: { description: expect.stringContaining("<d>[English] Hello!</d>"), soundscape: "waves, a light wind" },
      options: ["even warmer", "add seagulls", "the camera pushes in"],
    });
    expect(reply.changes.music).toBeUndefined();
    const s = system();
    expect(s).toContain("MiniMax H3 makes the picture AND the sound");
    expect(s).toContain("description: She waves at the boat.");
    expect(s).toContain("music: (empty)");
    expect(s).toContain("The clip is 6 seconds long");
    expect(s).toContain("CONTINUES the clip before it");
    expect(s).toContain("She walks to the railing.");
    expect(s).toContain("calm, film grain");
    expect(llm.asked[0]!.messages.at(-1)).toEqual({ role: "user", content: "make the light warmer" });
  });

  it("writes tags for a model that reads tags, improves on request, and can ask one question", async () => {
    await useLlm();
    llm.answers.push("kind: proposal\nnote: Fuller now.\nprompt: 1girl, solo, long hair, terrace, sunset, holding cup\nnegative: \nquality: ");
    const better = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "girl on a terrace", checkpoint: CHECKPOINT }, messages: [{ role: "user", content: "Improve it" }], mode: "enhance" })).json();
    expect(better.changes).toEqual({ prompt: "1girl, solo, long hair, terrace, sunset, holding cup" });
    expect(system()).toContain("comma-separated danbooru-style tags");
    expect(system()).toContain('pressed "Improve it"');

    llm.answers.push("kind: question\nnote: I need one thing.\nquestion: Indoors or outdoors?\noptions: indoors | outdoors");
    const ask = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "something cool" }] })).json();
    expect(ask).toMatchObject({ kind: "question", question: "Indoors or outdoors?", options: ["indoors", "outdoors"], changes: {} });
    expect(system()).toContain("Nothing is written yet");

    llm.answers.push("I cannot help with that.");
    const none = await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "x" }, messages: [{ role: "user", content: "hm" }] });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/nothing usable/);
  });

  it("is shown the opening picture when the language model can read pictures, and told not to invent the scene when it cannot", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=p.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id;
    await useLlm();
    const ask = () => post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "", start: picture }, messages: [{ role: "user", content: "she turns her head" }] });
    llm.answers.push("kind: proposal\nnote: ok\ndescription: She turns her head slowly.");
    expect((await ask()).json().sawPicture).toBe(false);
    expect(system()).toContain("You cannot see that picture");
    expect(typeof llm.asked.at(-1)!.messages.at(-1)!.content).toBe("string");

    await put("/api/settings", { llm: { vision: true } });
    llm.answers.push("kind: proposal\nnote: ok\ndescription: She turns her head slowly.");
    expect((await ask()).json().sawPicture).toBe(true);
    expect(system()).toContain("You are shown the picture");
    const last = llm.asked.at(-1)!.messages.at(-1)!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(last.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(last[1]!.image_url!.url).toMatch(/^data:image\/(webp|png);base64,/);
  });

  it("knows who is in it and does not repeat their words", async () => {
    await useLlm();
    const her = (await post(t.app, "/api/entities", { kind: "person", name: "Her", def: { sentence: "She has brown hair and green eyes.", tags: "brown hair, green eyes" } })).json();
    llm.answers.push("kind: proposal\nnote: ok\ndescription: The woman waves.");
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "" }, messages: [{ role: "user", content: "she waves" }], look: { cast: [{ id: her.id }], style: null } });
    expect(system()).toContain("- Her: She has brown hair and green eyes.");
    expect(system()).toContain("never repeat or contradict them");
  });
});

describe("a clip of a timeline", () => {
  it("is written knowing what every other clip says happens, and keeps its conversation", async () => {
    await useLlm();
    llm.answers.push("kind: proposal\nnote: ok\ndescription: She puts the cup down and walks to the railing.");
    await post(t.app, "/api/designer", {
      recipe: "h3.video", values: { description: "" }, messages: [{ role: "user", content: "write this one" }],
      story: { clips: ["She pours coffee on the terrace.", "", "She waves at a boat."], index: 1 },
    });
    const s = system();
    expect(s).toContain("THE WHOLE VIDEO is 3 clips");
    expect(s).toContain("1. She pours coffee on the terrace.");
    expect(s).toContain("2. (THIS CLIP) (nothing written yet)");
    expect(s).toContain("3. She waves at a boat.");
    expect(s).toContain("You only write clip 2.");

    const tl = (await post(t.app, "/api/timelines", {})).json();
    const clip = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip;
    const before = (await get(t.app, `/api/timelines/${tl.id}`)).json().undo;
    await t.app.inject({ method: "PATCH", url: `/api/clips/${clip}`, payload: { chat: [{ role: "user", content: "write this one" }] } });
    const now = (await get(t.app, `/api/timelines/${tl.id}`)).json();
    expect(now.clips[0].chat).toEqual([{ role: "user", content: "write this one" }]);
    // what is said to the designer is not a step to undo
    expect(now.undo).toBe(before);
  });
});

describe("a scene planned as clips", () => {
  const plan = `kind: plan
note: Three steps of one scene.
CLIP 1
description: She pours coffee on the terrace.
soundscape: a spoon on china
music: N/A
CLIP 2
description: The woman with brown hair walks to the railing, cup in hand.
soundscape: footsteps on wood
CLIP 3
description: The woman with brown hair waves at a boat and smiles.
soundscape: waves`;

  it("comes back as the text of each clip, and becomes clips that flow on from each other, with the mood of the video", async () => {
    await useLlm();
    llm.answers.push(plan);
    const made = (await post(t.app, "/api/designer/plan", { recipe: "h3.video", idea: "a woman has coffee, walks to the railing, waves at a boat", clips: 3 })).json();
    expect(made.note).toBe("Three steps of one scene.");
    expect(made.clips).toHaveLength(3);
    expect(made.clips[1]).toEqual({ description: "The woman with brown hair walks to the railing, cup in hand.", soundscape: "footsteps on wood" });
    expect(system()).toContain("PLAN a longer video as 3 clips");

    const tl = (await post(t.app, "/api/timelines", {})).json();
    await t.app.inject({ method: "PATCH", url: `/api/timelines/${tl.id}`, payload: { mood: "warm evening light" } });
    const done = (await post(t.app, `/api/timelines/${tl.id}/plan`, { recipe: "h3.video", clips: made.clips })).json();
    expect(done.timeline.clips.map((c: { joined: string; inputs: { description: string } }) => [c.joined, c.inputs.description.slice(0, 14)])).toEqual([
      ["continue", "She pours coff"], ["continue", "The woman with"], ["continue", "The woman with"],
    ]);
    expect(done.timeline.mood).toBe("warm evening light");
    // the mood of the video is added to what happens when a clip is rendered
    const first = done.timeline.clips[0];
    await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: first.id, input: first.inputs }] });
    await until(() => fake.prompts.size === 1);
    const node = Object.values([...fake.prompts.values()][0]!).find((n) => n.class_type === "MiniMaxH3ImageToVideo")!;
    expect(String(node.inputs.prompt)).toContain("She pours coffee on the terrace. warm evening light");
  });

  it("is asked for again when the first answer is not a plan", async () => {
    await useLlm();
    llm.answers.push("kind: proposal\nnote: Here is one clip.\ndescription: She pours coffee.", plan);
    const made = (await post(t.app, "/api/designer/plan", { recipe: "h3.video", idea: "coffee", clips: 2 })).json();
    expect(made.clips).toHaveLength(2);
    expect(llm.asked).toHaveLength(2);
  });
});

describe("snippets", () => {
  it("are bits of text kept under a name", async () => {
    const s = (await post(t.app, "/api/entities", { kind: "snippet", name: "Evening light", def: { text: "warm evening light, long shadows" } })).json();
    expect(s).toMatchObject({ kind: "snippet", name: "Evening light", def: { text: "warm evening light, long shadows" } });
    expect((await get(t.app, "/api/entities?kind=snippet")).json().items).toHaveLength(1);
  });
});
