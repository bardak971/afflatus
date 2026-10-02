import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
import { CHECKPOINT, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/** A stand-in for a language model's address: it answers what the test tells it to, and keeps what it was asked. */
interface FakeLlm {
  url: string;
  asked: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; auth: string | undefined; maxTokens: number }>;
  answers: string[];
  close(): Promise<void>;
}
async function startFakeLlm(): Promise<FakeLlm> {
  const llm: Omit<FakeLlm, "url" | "close"> = { asked: [], answers: [] };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { model: string; max_tokens: number; messages: FakeLlm["asked"][number]["messages"] };
    llm.asked.push({ model: body.model, messages: body.messages, auth: req.headers.authorization, maxTokens: body.max_tokens });
    res.writeHead(200, { "Content-Type": "application/json" });
    const answer = llm.answers.shift() ?? "kind: proposal\nnote: nothing";
    // "(cut)": it ran out of room before it wrote anything
    res.end(JSON.stringify({ choices: [answer === "(cut)" ? { message: { content: "" }, finish_reason: "length" } : { message: { content: answer }, finish_reason: "stop" }] }));
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
  it("is asked for in Settings, and its key is never handed back nor lost", async () => {
    expect((await post(t.app, "/api/designer/test")).json().error).toMatch(/no language model yet/);
    expect((await useLlm()).json().llm).toEqual({ baseUrl: llm.url, model: "test-model", hasApiKey: true, vision: false });
    // the address changes; the key is not sent again and stays
    await put("/api/settings", { llm: { vision: true } });
    llm.answers.push("ready");
    expect((await post(t.app, "/api/designer/test")).json()).toEqual({ ok: true, model: "test-model", answer: "ready" });
    expect(llm.asked[0]).toMatchObject({ model: "test-model", auth: "Bearer secret" });
    expect((await get(t.app, "/api/settings")).json().llm).toMatchObject({ hasApiKey: true, vision: true });
  });

  it("can be one of several: each with its own key and sizes, one in use, changed without sending its key again", async () => {
    await useLlm();
    const first = (await get(t.app, "/api/settings")).json();
    expect(first.llms).toEqual([{ id: "main", name: "", baseUrl: llm.url, model: "test-model", hasApiKey: true, vision: false, contextSize: 16384, maxOutputTokens: 3000 }]);
    expect(first.designerLlm).toBe("main");

    // a second one; the first is sent back without its key, which stays
    const { hasApiKey: _has, ...kept } = first.llms[0];
    const saved = (await put("/api/settings", { llms: [kept, { id: "big", name: "The big one", baseUrl: llm.url, model: "big-model", apiKey: "other", contextSize: 131072, maxOutputTokens: 8000 }] })).json();
    expect(saved.llms.map((l: { id: string; hasApiKey: boolean }) => [l.id, l.hasApiKey])).toEqual([["main", true], ["big", true]]);
    expect(JSON.stringify(saved)).not.toContain("secret");
    llm.answers.push("ready", "ready");
    await post(t.app, "/api/designer/test");
    expect(llm.asked.at(-1)).toMatchObject({ model: "test-model", auth: "Bearer secret" });
    // a given one is tested without being put in use
    expect((await post(t.app, "/api/designer/test", { id: "big" })).json()).toMatchObject({ model: "big-model" });
    expect(llm.asked.at(-1)).toMatchObject({ model: "big-model", auth: "Bearer other" });

    // the one in use writes, with the longest answer it was given
    await put("/api/settings", { designerLlm: "big" });
    llm.answers.push("kind: proposal\nnote: ok\nprompt: 1girl, terrace");
    await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "a girl on a terrace" }] });
    expect(llm.asked.at(-1)).toMatchObject({ model: "big-model", maxTokens: 8000 });
    expect((await get(t.app, "/api/settings")).json().llm).toMatchObject({ model: "big-model" });

    // removed: the designer goes back to the first
    await put("/api/settings", { llms: [kept] });
    expect((await get(t.app, "/api/settings")).json()).toMatchObject({ designerLlm: "main", llm: { model: "test-model", hasApiKey: true } });
    expect((await put("/api/settings", { llms: [kept, kept] })).statusCode).toBe(400);
  });

  it("is sent only as much of a long conversation as it can read, the latest part", async () => {
    await useLlm({ contextSize: 4096, maxOutputTokens: 1000 });
    const long = "word ".repeat(700); // about 1000 tokens each
    const messages = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}: ${long}` }));
    llm.answers.push("kind: proposal\nnote: ok\nprompt: 1girl");
    await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages });
    const sent = llm.asked.at(-1)!.messages;
    expect(sent[0]!.role).toBe("system");
    // the last thing said is there, the start of the conversation is not, and what is sent starts with the user
    expect(String(sent.at(-1)!.content)).toMatch(/^8: /);
    expect(sent.length).toBeLessThan(6);
    expect(sent[1]!.role).toBe("user");
    expect(sent.some((m) => String(m.content).startsWith("0: "))).toBe(false);
    expect(llm.asked.at(-1)!.maxTokens).toBe(1000);
  });

  it("is not blamed for thinking aloud, and says so when thinking used the whole answer", async () => {
    await useLlm();
    llm.answers.push("<think>The user wants a terrace.\nprompt: wrong, this is thinking</think>\nkind: proposal\nnote: ok\nprompt: 1girl, terrace");
    const reply = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "a terrace" }] })).json();
    expect(reply.changes).toEqual({ prompt: "1girl, terrace" });
    llm.answers.push("(cut)");
    const cut = await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "a terrace" }] });
    expect(cut.json().error).toMatch(/Max output tokens/);
  });
});

describe("the user's own instructions for the designer", () => {
  it("are kept under names, and the ones picked are part of what the designer is told, plans included", async () => {
    await useLlm();
    const said = { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "a terrace" }] };
    await post(t.app, "/api/designer", said);
    expect(system()).not.toContain("STANDING INSTRUCTIONS");

    await put("/api/settings", { designerInstructions: [{ id: "film", name: "Film", text: "Always name the lens." }, { id: "short", name: "Short", text: "Never more than ten tags." }], designerInstruction: "film" });
    await post(t.app, "/api/designer", said);
    expect(system()).toContain("THE USER'S STANDING INSTRUCTIONS");
    expect(system()).toContain("Always name the lens.");
    expect(system()).not.toContain("Never more than ten tags.");
    // they come before the model's guide, and the reply format still closes what it is told
    expect(system().indexOf("Always name the lens.")).toBeLessThan(system().indexOf("THE PARTS YOU WRITE"));
    expect(system().trimEnd().endsWith("separated by |")).toBe(true);

    await put("/api/settings", { designerInstruction: "short" });
    await post(t.app, "/api/designer/plan", { recipe: "h3.video", idea: "a walk", clips: 2 }).catch(() => {});
    expect(system(-1)).toContain("Never more than ten tags.");

    // the ones in use are removed: none are in use
    await put("/api/settings", { designerInstructions: [{ id: "film", name: "Film", text: "Always name the lens." }] });
    expect((await get(t.app, "/api/settings")).json().designerInstruction).toBe("");
    await post(t.app, "/api/designer", said);
    expect(system()).not.toContain("STANDING INSTRUCTIONS");
  });
});

describe("a conversation's own language model and instructions", () => {
  it("are the ones it says, whatever is the usual choice; one that is gone falls back to the usual", async () => {
    await useLlm();
    const { hasApiKey: _has, ...kept } = (await get(t.app, "/api/settings")).json().llms[0];
    await put("/api/settings", {
      llms: [kept, { id: "big", baseUrl: llm.url, model: "big-model" }],
      designerInstructions: [{ id: "film", name: "Film", text: "Always name the lens." }, { id: "short", name: "Short", text: "Never more than ten tags." }],
      designerInstruction: "film",
    });
    const say = (session: Record<string, unknown>) => post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "a terrace" }], ...session });

    // nothing said: the usual model, the usual instructions
    await say({});
    expect(llm.asked.at(-1)!.model).toBe("test-model");
    expect(system()).toContain("Always name the lens.");
    // its own: another model, other instructions
    await say({ llm: "big", instruction: "short" });
    expect(llm.asked.at(-1)!.model).toBe("big-model");
    expect(system()).toContain("Never more than ten tags.");
    expect(system()).not.toContain("Always name the lens.");
    // "no instructions" on purpose is not "the usual ones"
    await say({ instruction: "" });
    expect(system()).not.toContain("STANDING INSTRUCTIONS");
    // a model or instructions removed from Settings since: the usual model, and no instructions rather than someone else's
    await say({ llm: "gone", instruction: "gone" });
    expect(llm.asked.at(-1)!.model).toBe("test-model");
    expect(system()).not.toContain("STANDING INSTRUCTIONS");
  });

  it("are kept with the draft", async () => {
    const draft = (await post(t.app, "/api/drafts", { recipe: "sdxl.text-to-picture" })).json();
    expect(draft.designer).toBeNull();
    const saved = (await put(`/api/drafts/${draft.id}`, { designer: { llm: "big", instruction: "" } })).json();
    expect(saved.designer).toEqual({ llm: "big", instruction: "" });
    // saving something else leaves it; null goes back to the usual ones
    expect((await put(`/api/drafts/${draft.id}`, { count: 2 })).json().designer).toEqual({ llm: "big", instruction: "" });
    expect((await put(`/api/drafts/${draft.id}`, { designer: null })).json().designer).toBeNull();
  });
});

describe("a fresh start", () => {
  it("forgets every conversation, in drafts and on timelines, and leaves the forms alone", async () => {
    const turns = [{ role: "user", content: "a terrace" }, { role: "assistant", content: "ok" }];
    const draft = (await post(t.app, "/api/drafts", { recipe: "sdxl.text-to-picture", forms: { "sdxl.text-to-picture": { prompt: "1girl, terrace" } } })).json();
    await put(`/api/drafts/${draft.id}`, { chat: turns });
    expect((await get(t.app, `/api/drafts/${draft.id}`)).json().chat).toHaveLength(2);

    expect((await t.app.inject({ method: "DELETE", url: "/api/designer/conversations" })).json()).toEqual({ forgotten: 1 });
    const after = (await get(t.app, `/api/drafts/${draft.id}`)).json();
    expect(after.chat).toEqual([]);
    expect(after.forms["sdxl.text-to-picture"].prompt).toBe("1girl, terrace");
    expect((await t.app.inject({ method: "DELETE", url: "/api/designer/conversations" })).json()).toEqual({ forgotten: 0 });
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

describe("what the designer is told about writing", () => {
  it("is told how many words can be spoken in the clip, as room to use and not only a limit", async () => {
    await useLlm();
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "She waves.", seconds: 8 }, messages: [{ role: "user", content: "she says something" }] });
    const s = system();
    expect(s).toContain("SPOKEN LINES: about 20 words fit in this clip");
    expect(s).toContain("14 to 20 words in all");
    // a model that makes no sound is told nothing about speech
    await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "1girl" }, messages: [{ role: "user", content: "more" }] });
    expect(system()).not.toContain("SPOKEN LINES");
  });

  it("keeps the user's choices in braces, and knows the snippets that are ticked", async () => {
    await useLlm();
    const snippet = (await post(t.app, "/api/entities", { kind: "snippet", name: "Sitting", def: { text: "sitting, crossed legs" } })).json();
    await post(t.app, "/api/designer", {
      recipe: "sdxl.text-to-picture", values: { prompt: "1girl, {red|black} dress" }, messages: [{ role: "user", content: "more" }], look: { cast: [], snippets: [snippet.id] },
    });
    const s = system();
    expect(s).toContain("Choices in braces like {red|black|white} are the user's");
    expect(s).toContain("- Sitting: sitting, crossed legs");
  });

  it("has its tags put right against danbooru's list, unless that is turned off", async () => {
    await useLlm();
    const ask = async () => (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "1girl" }, messages: [{ role: "user", content: "happier" }] })).json();
    llm.answers.push("kind: proposal\nnote: Happier.\nprompt: 1girl, (grinning:1.2), zzqqxx thing\nnegative: grinning");
    const reply = await ask();
    expect(reply.changes.prompt).toBe("1girl, (grin:1.2), zzqqxx thing");
    // the negative prompt is left as written
    expect(reply.changes.negative).toBe("grinning");
    expect(reply.tags).toEqual({ fixed: [{ from: "(grinning:1.2)", to: "(grin:1.2)" }], unknown: ["zzqqxx thing"] });

    await put("/api/settings", { tagCheck: false });
    llm.answers.push("kind: proposal\nnote: Happier.\nprompt: 1girl, (grinning:1.2)");
    const plain = await ask();
    expect(plain.changes.prompt).toBe("1girl, (grinning:1.2)");
    expect(plain.tags).toBeUndefined();
  });
});
