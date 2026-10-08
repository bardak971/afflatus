import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { chatJson, repeated } from "../src/designer";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

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
    // with Vision on, the test also shows the model a red square: it answered the colour, so it reads pictures
    llm.answers.push("ready", "Red.");
    expect((await post(t.app, "/api/designer/test")).json()).toEqual({ ok: true, model: "test-model", answer: "ready", ms: expect.any(Number), thinks: false, vision: { ok: true, answer: "Red." } });
    expect(llm.asked.at(-1)!.messages[0]!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
    expect(llm.asked[0]).toMatchObject({ model: "test-model", auth: "Bearer secret" });
    expect((await get(t.app, "/api/settings")).json().llm).toMatchObject({ hasApiKey: true, vision: true });
  });

  it("can be one of several: each with its own key and sizes, one in use, changed without sending its key again", async () => {
    await useLlm();
    const first = (await get(t.app, "/api/settings")).json();
    expect(first.llms).toEqual([{ id: "main", name: "", baseUrl: llm.url, model: "test-model", hasApiKey: true, vision: false, contextSize: 16384, maxOutputTokens: 3000, noThinking: false }]);
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
    // one Settings does not have: not found, and nothing is asked of any model
    const asked = llm.asked.length;
    expect((await post(t.app, "/api/designer/test", { id: "gone" })).statusCode).toBe(404);
    expect(llm.asked.length).toBe(asked);

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

describe("a clip that carries on from another", () => {
  const before = "She walks along the terrace at sunset, stops at the railing and looks out at the sea. The woman (S1) says softly: what a view. The camera follows her slowly from behind.";

  it("is told that the clip before is over, and is asked again when it writes that clip a second time", async () => {
    await useLlm();
    const ask = { recipe: "h3.video", values: { description: "" }, previous: before, messages: [{ role: "user", content: "Write what happens next" }] };
    // the clip before, handed back barely reworded; told so, it writes what comes after
    llm.answers.push(`kind: proposal\ndescription: ${before.replace("softly", "quietly")}\nnote: Here it is.`, "kind: proposal\ndescription: She turns from the railing, laughs and sits down at the table. The woman (S1) says: let us stay a while.\nnote: What comes next.");
    const fixed = (await post(t.app, "/api/designer", ask)).json();
    expect(fixed).toMatchObject({ kind: "proposal", retried: true });
    expect(fixed.changes.description).toContain("sits down at the table");
    expect(fixed.repeats).toBeUndefined();
    expect(system(0)).toContain("which has ALREADY HAPPENED and is not to be shown or said again");
    expect(system(0)).toContain("Write ONLY what comes after it");
    expect(String(llm.asked[1]!.messages.at(-1)!.content)).toContain("says again what the clip before says");

    // it does it twice: the text is kept, and said to be the clip before
    llm.answers.push(`kind: proposal\ndescription: ${before}\nnote: Here it is.`, `kind: proposal\ndescription: ${before.replace("softly", "gently")}\nnote: Again.`);
    const twice = (await post(t.app, "/api/designer", ask)).json();
    expect(twice).toMatchObject({ kind: "proposal", repeats: true });

    // without a clip before, the same text is nothing to object to
    const n = llm.asked.length;
    llm.answers.push(`kind: proposal\ndescription: ${before}\nnote: ok`);
    const alone = (await post(t.app, "/api/designer", { ...ask, previous: undefined })).json();
    expect(alone.repeats).toBeUndefined();
    expect(llm.asked).toHaveLength(n + 1);
  });

  it("tells a text said again from one that only shares the people and the place", () => {
    expect(repeated(before, before)).toBe(1);
    expect(repeated(before.replace("softly", "quietly"), before)).toBeGreaterThan(0.8);
    expect(repeated("She turns from the railing, laughs and sits down at the table on the terrace at sunset. The woman (S1) says: let us stay a while.", before)).toBeLessThan(0.3);
    // too short to say
    expect(repeated("She waves.", before)).toBe(0);
  });
});

describe("a long conversation", () => {
  it("loses its oldest exchanges when it outgrows its room, and can always be read back", async () => {
    const turn = (i: number) => [{ role: "user", content: `ask ${i}` }, { role: "assistant", content: "x".repeat(900), reply: { kind: "proposal", note: "ok", changes: { prompt: "y".repeat(900) } } }];
    const chat = Array.from({ length: 12 }, (_x, i) => turn(i)).flat();
    const stored = chatJson(chat, 8000)!;
    expect(stored.length).toBeLessThanOrEqual(8000);
    const kept = JSON.parse(stored) as Array<{ role: string; content: string }>;
    // whole exchanges, the latest ones, starting with what the user said
    expect(kept[0]).toMatchObject({ role: "user" });
    expect(kept.at(-2)).toEqual({ role: "user", content: "ask 11" });
    expect(kept.length % 2).toBe(0);
    expect(chatJson([], 8000)).toBeNull();
    expect(JSON.parse(chatJson(chat)!)).toHaveLength(24);

    // kept with a draft through the API all the same
    const draft = (await post(t.app, "/api/drafts", { recipe: "sdxl.text-to-picture" })).json();
    await put(`/api/drafts/${draft.id}`, { chat });
    expect((await get(t.app, `/api/drafts/${draft.id}`)).json().chat).toHaveLength(24);
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
    expect(system()).toContain("DANBOORU TAGS");
    expect(system()).toContain('pressed "Improve it"');

    llm.answers.push("kind: question\nnote: I need one thing.\nquestion: Indoors or outdoors?\noptions: indoors | outdoors");
    const ask = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "" }, messages: [{ role: "user", content: "something cool" }] })).json();
    expect(ask).toMatchObject({ kind: "question", question: "Indoors or outdoors?", options: ["indoors", "outdoors"], changes: {} });
    expect(system()).toContain("Nothing is written yet");

    // plain sentences without the labels are an answer, not an error
    llm.answers.push("I cannot help with that.");
    const plain = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "x" }, messages: [{ role: "user", content: "hm" }] })).json();
    expect(plain).toMatchObject({ kind: "answer", note: "I cannot help with that.", changes: {} });
    // nothing at all is still an error
    llm.answers.push("   ");
    const none = await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "x" }, messages: [{ role: "user", content: "hm" }] });
    // the language model's fault, not the asker's: a bad gateway
    expect(none.statusCode).toBe(502);
    expect(none.json().error).toMatch(/nothing usable/);
  });

  it("answers when it is only asked something, with ideas to pick from, and changes nothing", async () => {
    await useLlm();
    llm.answers.push("kind: answer\nnote: Yes: a woman on a terrace, tagged as 1girl. She could hold a cup, or lean on the railing.\noptions: she holds a cup | she leans on the railing");
    const reply = (await post(t.app, "/api/designer", { recipe: "sdxl.text-to-picture", values: { prompt: "1girl, terrace" }, messages: [{ role: "user", content: "do you see the prompt? any ideas?" }] })).json();
    expect(reply).toMatchObject({ kind: "answer", changes: {}, options: ["she holds a cup", "she leans on the railing"] });
    expect(reply.note).toContain("a woman on a terrace");
    expect(reply.empty).toBeUndefined();
    // one question, one call: an answer is not asked for again
    expect(llm.asked).toHaveLength(1);
    expect(system()).toContain("THIS IS A CONVERSATION");
    expect(system()).toContain("never say you changed, wrote or printed something without its text being there");
    // the text comes before the note in what it is asked to send
    expect(system().indexOf("\nprompt: the WHOLE new text")).toBeLessThan(system().indexOf("\nnote: one or two short sentences"));
  });

  it("is asked again when it says it changed the prompt and sent no text, and is not believed when it does it twice", async () => {
    await useLlm();
    const ask = { recipe: "sdxl.text-to-picture", values: { prompt: "1girl, terrace" }, messages: [{ role: "user", content: "make her smile" }] };
    // the first reply claims a change with nothing behind it; told so, it sends the text
    llm.answers.push("kind: proposal\nnote: I made her smile.", "kind: proposal\nprompt: 1girl, terrace, smile\nnote: She smiles now.");
    const fixed = (await post(t.app, "/api/designer", ask)).json();
    expect(fixed).toMatchObject({ kind: "proposal", changes: { prompt: "1girl, terrace, smile" }, note: "She smiles now.", retried: true });
    expect(llm.asked).toHaveLength(2);
    const second = llm.asked[1]!.messages;
    expect(second.at(-2)).toEqual({ role: "assistant", content: "kind: proposal\nnote: I made her smile." });
    expect(String(second.at(-1)!.content)).toContain("Your reply carried no new text");

    // the same text as what is written is no change either
    llm.answers.push("kind: proposal\nnote: Done.\nprompt: 1girl, terrace", "kind: proposal\nnote: Here is the full updated prompt.");
    const twice = (await post(t.app, "/api/designer", ask)).json();
    expect(twice).toMatchObject({ kind: "answer", empty: true, changes: {}, note: "Here is the full updated prompt." });
    expect(twice.raw).toContain("note: Done.");
    expect(llm.asked).toHaveLength(4);

    // asked again, it says plainly that it will not: that is an answer, and nothing is hidden
    llm.answers.push("kind: proposal\nnote: I updated it.", "kind: answer\nnote: I will not write that.");
    const refused = (await post(t.app, "/api/designer", ask)).json();
    expect(refused).toMatchObject({ kind: "answer", note: "I will not write that.", retried: true });
    expect(refused.empty).toBeUndefined();
  });

  it("is asked again when it sends a fragment in place of the whole text, and the fragment is flagged when it insists", async () => {
    await useLlm();
    const long = `${"She walks along the terrace at sunset, the low light warm on her face, her linen dress moving in the wind. ".repeat(4)}She says: hello.`;
    const whole = long.replace("hello", "what a view");
    const ask = (words: string) => ({ recipe: "h3.video", values: { description: long }, messages: [{ role: "user", content: words }] });
    // only the changed line comes back: using it would wipe the rest
    llm.answers.push("kind: proposal\ndescription: She says: what a view.\nnote: New line.", `kind: proposal\ndescription: ${whole}\nnote: New line, in the whole text.`);
    const fixed = (await post(t.app, "/api/designer", ask("change what she says"))).json();
    expect(fixed).toMatchObject({ kind: "proposal", changes: { description: whole }, retried: true });
    expect(fixed.short).toBeUndefined();
    expect(String(llm.asked[1]!.messages.at(-1)!.content)).toContain("reads as a fragment");

    // it insists: the short text is kept, flagged with the two lengths
    llm.answers.push("kind: proposal\ndescription: She says: what a view.\nnote: New line.", "kind: proposal\ndescription: She says: what a view.\nnote: New line.");
    const short = (await post(t.app, "/api/designer", ask("change what she says"))).json();
    expect(short.changes).toEqual({ description: "She says: what a view." });
    expect(short.short).toEqual({ description: { was: long.length, now: "She says: what a view.".length } });

    // a shorter text that was asked for is not a fragment
    const before = llm.asked.length;
    llm.answers.push("kind: proposal\ndescription: She walks along the terrace and says hello.\nnote: Shorter.");
    const wanted = (await post(t.app, "/api/designer", ask("Shorter"))).json();
    expect(wanted.short).toBeUndefined();
    expect(llm.asked).toHaveLength(before + 1);
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

  it("knows the prompt a picture was made from, when the clip opens on a picture Afflatus made", async () => {
    await useLlm();
    // a picture made here, from a prompt of tags
    const job = (await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "1girl, red dress, terrace at sunset, holding a cup", checkpoint: CHECKPOINT } })).json().ids[0] as string;
    await until(() => fake.prompts.size === 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", job).executeTakeFirstOrThrow()).status === "done");
    const picture = (await get(t.app, "/api/assets")).json().items[0].id as string;

    // a video that opens on it: the designer is told what the picture was made from
    llm.answers.push("kind: proposal\ndescription: The woman in the red dress lifts her cup and smiles.\nnote: ok");
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "", start: picture }, messages: [{ role: "user", content: "she drinks" }] });
    const s1 = system();
    expect(s1).toContain("The picture that is the first frame was made here, in one step:\n1. txt2img with SDXL: 1girl, red dress, terrace at sunset, holding a cup");
    expect(s1).toContain("1girl, red dress, terrace at sunset, holding a cup");
    expect(s1).toContain("what you know of it is the prompt it was made from");
    expect(s1).not.toContain("Never invent a place, props, light");

    // a picture that came from elsewhere says nothing: the designer is told not to invent
    const mine = (await t.app.inject({ method: "POST", url: "/api/assets?name=mine.png", headers: { "content-type": "image/png" }, payload: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") })).json();
    expect(mine.id).toBeTruthy();
    llm.answers.push("kind: proposal\ndescription: She turns her head.\nnote: ok");
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "", start: mine.id }, messages: [{ role: "user", content: "she turns" }] });
    expect(system()).not.toContain("was made here");
    expect(system()).toContain("Never invent a place, props, light");
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

describe("what the designer knows of what Afflatus made", () => {
  /** Rows as the queue would have left them: a render, and what came out of it. */
  let n = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
  const render = async (recipe: string, family: string, inputs: Record<string, unknown>, opts: { from?: Array<{ asset: string; role: string }>; look?: unknown; kind?: "image" | "video" } = {}) => {
    const g = `g${n}`;
    const a = `a${n}`;
    await t.db.insertInto("generations").values({ id: g, owner_id: "owner", recipe_id: recipe, recipe_version: 1, family, inputs: JSON.stringify(inputs), resolved: JSON.stringify({ seed: 1, loads: [], ...(opts.look ? { look: opts.look } : {}) }), gen_ms: 1000, draft_id: null, created_at: at() }).execute();
    for (const f of opts.from ?? []) await t.db.insertInto("generation_inputs").values({ generation_id: g, asset_id: f.asset, role: f.role }).execute();
    await item(a, opts.kind ?? "image", { generation_id: g });
    return a;
  };
  const item = async (id: string, kind: "image" | "video", over: { generation_id?: string; source_id?: string; origin?: "generated" | "uploaded" | "frame" } = {}) => {
    await t.db.insertInto("assets").values({
      id, owner_id: "owner", kind, origin: over.origin ?? "generated", name: "", file_key: `assets/${id}`, thumb_key: null, mime: kind === "image" ? "image/png" : "video/mp4", bytes: 1,
      width: 832, height: 1216, duration_ms: kind === "video" ? 5000 : null, fps: kind === "video" ? 24 : null, has_sound: 0, folder_id: null,
      generation_id: over.generation_id ?? null, source_id: over.source_id ?? null, kept_at: at(), deleted_at: null, created_at: at(),
    }).execute();
    return id;
  };
  const knows = async (values: Record<string, unknown>, recipe = "h3.video") => (await post(t.app, "/api/designer/knows", { recipe, values })).json();

  it("follows a picture back through its upscale and its edit to the prompt it started as, with the LoRAs that shaped it", async () => {
    await useLlm();
    await t.db.insertInto("model_words").values({ folder: "loras", name: "inkstyle.safetensors", own: "ink wash, sumi-e", found: null, asked_at: null }).execute();
    const first = await render("sdxl.text-to-picture", "sdxl", { prompt: "1girl, red dress, terrace at sunset", checkpoint: CHECKPOINT, loras: [{ file: "Style\\inkstyle.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }] });
    // a reference picture of someone is not what the result "was": the trail does not go that way
    await item("someone", "image", { origin: "uploaded" });
    const edited = await render("klein.edit", "klein", { source: first, prompt: "Make the dress blue." }, { from: [{ asset: first, role: "source" }, { asset: "someone", role: "person" }] });
    const large = await render("sdxl.sharper", "sdxl", { source: edited, prompt: "", upscaler: "u.pth", checkpoint: CHECKPOINT }, { from: [{ asset: edited, role: "source" }] });

    expect(await knows({ start: large })).toEqual({
      continues: false,
      pictures: [{ what: "The picture that is the first frame", steps: [{ title: "txt2img", with: "SDXL", said: true }, { title: "Edit (instruction)", with: "FLUX.2 Klein", said: true }, { title: "Upscale 2x", with: "SDXL", said: false }] }],
    });

    llm.answers.push("kind: proposal\ndescription: The woman in the blue dress turns to the sea.\nnote: ok");
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "", start: large }, messages: [{ role: "user", content: "she turns" }] });
    const told = system();
    expect(told).toContain("The picture that is the first frame was made here, in 3 steps, the oldest first:");
    expect(told).toContain("1. txt2img with SDXL: 1girl, red dress, terrace at sunset\n   LoRAs on it: inkstyle (its words: ink wash, sumi-e)");
    expect(told).toContain("2. Edit (instruction) with FLUX.2 Klein: Make the dress blue.");
    expect(told).toContain("3. Upscale 2x with SDXL (no text of its own");
    expect(told).toContain("a later step that changes something wins over an earlier one");
    expect(told).toContain("is NOT in use now");
    // a LoRA at weight 0 was not on it
    expect(told).not.toContain("off (");
  });

  it("knows a frame saved from a video by that video's story, and the clip a new one carries on from", async () => {
    await useLlm();
    const picture = await render("sdxl.text-to-picture", "sdxl", { prompt: "1girl, terrace", checkpoint: CHECKPOINT });
    const clip = await render("h3.video", "h3", { description: "She walks to the railing and says hello.", soundscape: "waves, a light wind", start: picture }, { from: [{ asset: picture, role: "start" }], kind: "video" });
    const frame = await item("frame1", "image", { source_id: clip, origin: "frame" });

    // a new clip that opens on the saved frame
    const opens = await knows({ start: frame });
    expect(opens.pictures[0].steps.map((x: { title: string }) => x.title)).toEqual(["txt2img", "Video with audio"]);
    // a new clip that carries on from the video itself, as "Continue this clip" sets it up in Studio
    // it is given that clip's whole story: the picture it opened on, then the clip itself
    const carries = await knows({ previous: { asset: clip } });
    expect(carries.continues).toBe(true);
    expect(carries.pictures).toEqual([{ what: "The clip this one carries on from", steps: [{ title: "txt2img", with: "SDXL", said: true }, { title: "Video with audio", with: "MiniMax H3", said: true }] }]);
    llm.answers.push("kind: proposal\ndescription: She leans on the railing.\nnote: ok");
    await post(t.app, "/api/designer", { recipe: "h3.video", values: { description: "", previous: { asset: clip } }, messages: [{ role: "user", content: "what next" }] });
    expect(system()).toContain("CONTINUES the clip before it");
    expect(system()).toContain("She walks to the railing and says hello.");
    expect(system()).toContain("The clip this one carries on from was made here, in 2 steps, the oldest first:\n1. txt2img with SDXL: 1girl, terrace\n2. Video with audio with MiniMax H3: She walks to the railing and says hello.\n   Sound effects: waves, a light wind");

    // something Afflatus did not make has no story
    const mine = await item("mine1", "image", { origin: "uploaded" });
    expect(await knows({ start: mine })).toEqual({ pictures: [], continues: false });
  });

  it("hands the cast of a picture on to what is made from it, through an upscale too", async () => {
    const her = (await post(t.app, "/api/entities", { kind: "person", name: "Her" })).json();
    const look = { cast: [{ id: her.id }], style: null, snippets: [] };
    const picture = await render("sdxl.text-to-picture", "sdxl", { prompt: "1girl", checkpoint: CHECKPOINT }, { look });
    const large = await render("sdxl.sharper", "sdxl", { source: picture, upscaler: "u.pth", checkpoint: CHECKPOINT }, { from: [{ asset: picture, role: "source" }] });
    expect((await get(t.app, `/api/assets/${picture}`)).json().look).toMatchObject({ cast: [{ id: her.id }] });
    expect((await get(t.app, `/api/assets/${large}`)).json().look).toMatchObject({ cast: [{ id: her.id }] });
    const alone = await render("sdxl.text-to-picture", "sdxl", { prompt: "a cup", checkpoint: CHECKPOINT });
    expect((await get(t.app, `/api/assets/${alone}`)).json().look).toBeNull();
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
