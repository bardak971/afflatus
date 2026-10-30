import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { newId, OWNER } from "../src/db";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Notices (notify.ts) against a pretend Telegram and a pretend Discord: each hook says its message once, the limits hold,
 * a picture goes as a photo, a send that fails breaks nothing, and the token and the webhook never leave the server.
 */

const TOKEN = "123456789:AAE_test-token-0123456789abcdef";
const HOOK_PATH = "/api/webhooks/1234567890/hook-secret-0123456789";

interface Heard { url: string; type: string; body: Buffer }
interface FakeSite { url: string; heard: Heard[]; answer: (req: IncomingMessage, body: Buffer) => { status: number; json: unknown }; close(): Promise<void> }

/** A local http server that keeps every request and answers as told. */
async function fakeSite(answer: FakeSite["answer"]): Promise<FakeSite> {
  const site: FakeSite = { url: "", heard: [], answer, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      site.heard.push({ url: req.url ?? "", type: req.headers["content-type"] ?? "", body });
      const said = site.answer(req, body);
      res.writeHead(said.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(said.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () => new Promise((r) => server.close(() => r()));
  return site;
}

let fake: FakeComfy;
let telegram: FakeSite;
let discord: FakeSite;
let t: TestApp;
let updates: unknown[] = [];

beforeEach(async () => {
  updates = [];
  telegram = await fakeSite((req) => (req.url?.includes("/getUpdates") ? { status: 200, json: { ok: true, result: updates } } : { status: 200, json: { ok: true, result: {} } }));
  discord = await fakeSite(() => ({ status: 204, json: {} }));
  vi.stubEnv("TELEGRAM_URL", telegram.url);
  vi.stubEnv("DISCORD_URL", `${discord.url}/api/webhooks/`);
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  // the envs unstubbed last: a RunPod call still under way until the close (a hunt's round, a poll) read them
  // again and, without them, went to RunPod itself
  vi.unstubAllEnvs();
  await Promise.all([fake, telegram, discord].map((x) => x.close().catch(() => {})));
});

const put = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/settings", payload: payload as object });
const setUp = (events: Record<string, unknown> = {}) => put({ notify: { telegramToken: TOKEN, telegramChat: "42", discordWebhook: `${discord.url}${HOOK_PATH}`, events } });
/** What the pretend Telegram was sent as text (a message's text, a photo's caption), in order. */
const texts = () => telegram.heard.filter((h) => !h.url.includes("getUpdates")).map((h) => (h.type.startsWith("application/json") ? (JSON.parse(h.body.toString()) as { text: string }).text : h.body.toString("latin1")));
const discordTexts = () => discord.heard.map((h) => (h.type.startsWith("application/json") ? (JSON.parse(h.body.toString()) as { content: string }).content : h.body.toString("latin1")));
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const statusOf = async (id: string) => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const submitted = () => [...fake.prompts.keys()];

describe("the settings", () => {
  it("keep the token and the webhook on the server, merge what the page sends, and refuse what cannot be one", async () => {
    expect((await get(t.app, "/api/settings")).json().notify).toMatchObject({ hasTelegramToken: false, hasDiscordWebhook: false, picture: true, events: { renderDone: { telegram: false, discord: false }, renderFailed: { telegram: true, discord: true } } });
    await setUp();
    const read = (await get(t.app, "/api/settings")).body;
    expect(read).not.toContain(TOKEN);
    expect(read).not.toContain("hook-secret");
    expect(JSON.parse(read).notify).toMatchObject({ hasTelegramToken: true, telegramChat: "42", hasDiscordWebhook: true });
    // one tick sent alone: the others, the token and the webhook stay
    await put({ notify: { events: { queueEmpty: { discord: false } } } });
    const after = (await get(t.app, "/api/settings")).json().notify;
    expect(after).toMatchObject({ hasTelegramToken: true, hasDiscordWebhook: true, events: { queueEmpty: { telegram: true, discord: false }, renderFailed: { telegram: true, discord: true } } });
    // a webhook elsewhere than Discord, and a token that is not one, are refused
    expect((await put({ notify: { discordWebhook: "https://example.com/api/webhooks/1/x" } })).statusCode).toBe(400);
    expect((await put({ notify: { telegramToken: "not-a-token" } })).statusCode).toBe(400);
    // "" takes one off
    await put({ notify: { telegramToken: "" } });
    expect((await get(t.app, "/api/settings")).json().notify.hasTelegramToken).toBe(false);
  });
});

describe("Send a test and Find my chat id", () => {
  it("sends \"Afflatus: test\" to each channel, and says a refusal without the token", async () => {
    await setUp();
    expect((await post(t.app, "/api/notify/test", { channel: "telegram" })).json()).toEqual({ ok: true });
    expect(telegram.heard[0]!.url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(telegram.heard[0]!.body.toString())).toMatchObject({ chat_id: "42", parse_mode: "HTML", text: "<b>Afflatus: test</b>\nNotices will come here." });
    expect((await post(t.app, "/api/notify/test", { channel: "discord" })).json()).toEqual({ ok: true });
    expect(discord.heard[0]!.url).toBe(HOOK_PATH);
    expect(JSON.parse(discord.heard[0]!.body.toString())).toMatchObject({ content: "**Afflatus: test**\nNotices will come here.", allowed_mentions: { parse: [] } });
    // a refusal that names the token is said with the token taken out
    telegram.answer = () => ({ status: 401, json: { ok: false, description: `Unauthorized: bot${TOKEN} unknown` } });
    const refused = await post(t.app, "/api/notify/test", { channel: "telegram" });
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toMatch(/Telegram refused it: Unauthorized/);
    expect(refused.body).not.toContain(TOKEN);
  });

  it("asks for credentials first", async () => {
    expect((await post(t.app, "/api/notify/test", { channel: "telegram" })).statusCode).toBe(409);
    expect((await post(t.app, "/api/notify/telegram-chat")).statusCode).toBe(409);
  });

  it("finds the chats that wrote to the bot", async () => {
    await setUp();
    updates = [
      { update_id: 1, message: { chat: { id: 4242, type: "private", first_name: "Ada", last_name: "L" } } },
      { update_id: 2, message: { chat: { id: 4242, type: "private", first_name: "Ada", last_name: "L" } } },
      { update_id: 3, my_chat_member: { chat: { id: -100777, type: "supergroup", title: "Renders" } } },
    ];
    const res = await post(t.app, "/api/notify/telegram-chat");
    expect(res.json().chats).toEqual([{ id: "4242", name: "Ada L", type: "private" }, { id: "-100777", name: "Renders", type: "supergroup" }]);
    expect(telegram.heard.at(-1)!.url).toMatch(new RegExp(`^/bot${TOKEN.replace(/[:]/g, "\\:")}/getUpdates`));
  });
});

describe("what the queue tells", () => {
  it("a render done (when ticked), and the queue empty once, with its batch", async () => {
    await setUp({ renderDone: { telegram: true } });
    const notices: unknown[] = [];
    t.services.queue.events.on("notice", (n) => notices.push(n));
    const id = await enqueue();
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)) === "done");
    await until(() => texts().length === 2);
    expect(texts()[0]).toMatch(/^<b>Done: .+<\/b>\nillustrious · \d+ s$/);
    expect(texts()[1]).toMatch(/^<b>Queue empty<\/b>\n1 render done · in \d+ s$/);
    // Discord: render done was left off there, the queue empty is on by default
    await until(() => discordTexts().length === 1);
    expect(discordTexts()[0]).toMatch(/^\*\*Queue empty\*\*/);
    // the pages heard both, whatever the channels' ticks
    expect(notices).toMatchObject([{ kind: "renderDone" }, { kind: "queueEmpty", title: "Queue empty" }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(texts()).toHaveLength(2);
  });

  it("a render failed, with ComfyUI's reason, and the batch's failures by name", async () => {
    await setUp();
    const id = await enqueue();
    await until(() => submitted().length === 1);
    fake.history[submitted()[0]!] = { status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA out of memory\nTraceback…" }]] } };
    await until(async () => (await statusOf(id)) === "failed");
    await until(() => texts().length === 2);
    expect(texts()[0]).toMatch(/^<b>Failed: .+<\/b>\nCUDA out of memory$/);
    expect(texts()[1]).toMatch(/^<b>Queue empty<\/b>\n1 failed \(.+\) · in \d+ s$/);
  });

  it("a send that fails never breaks the render, and is logged once, without the token", async () => {
    await setUp({ renderDone: { telegram: true } });
    telegram.answer = () => ({ status: 500, json: { ok: false, description: `boom ${TOKEN}` } });
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    for (let i = 0; i < 2; i++) {
      const id = await enqueue({ prompt: `a cat ${i}` });
      await until(() => submitted().length === i + 1);
      complete(fake, submitted()[i]!);
      await until(async () => (await statusOf(id)) === "done");
    }
    await until(() => texts().length >= 3);
    await new Promise((r) => setTimeout(r, 100));
    const said = [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls].map((c) => c.join(" "));
    expect(said.filter((s) => s.includes("[notify] telegram not sent"))).toHaveLength(1);
    expect(said.join("\n")).not.toContain(TOKEN);
    expect(said.join("\n")).not.toContain("hook-secret");
  });

  it("a render with no progress for long, once; a ComfyUI gone mid-render, once", async () => {
    await setUp();
    const id = await enqueue();
    await until(() => submitted().length === 1 && t.services.queue.stillFor().length === 1);
    t.services.notify.opts.stuckMs = 1;
    await new Promise((r) => setTimeout(r, 5));
    await t.services.notify.lookStuck();
    await t.services.notify.lookStuck();
    await until(() => texts().some((x) => x.startsWith("<b>Stuck: ")));
    expect(texts().filter((x) => x.startsWith("<b>Stuck: "))).toHaveLength(1);
    expect(texts().find((x) => x.startsWith("<b>Stuck: "))).toMatch(/No step, node or preview for \d+ s on ComfyUI\. It runs on/);
    const q = t.services.queue;
    q.noteReachable(true, new Map([["m1", true]]));
    // one answer missed, or silent under 30 s: no news (a ComfyUI loading a model, a PC paging, answers late and renders on)
    q.noteReachable(false, new Map([["m1", false]]), 1_000);
    q.noteReachable(false, new Map([["m1", false]]), 20_000);
    q.noteReachable(true, new Map([["m1", true]]), 22_000);
    q.noteReachable(false, new Map([["m1", false]]), 24_000);
    q.noteReachable(false, new Map([["m1", false]]), 50_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(texts().filter((x) => x.startsWith("<b>ComfyUI is offline"))).toHaveLength(0);
    // silent 30 s in a row while it renders: said, once
    q.noteReachable(false, new Map([["m1", false]]), 54_000);
    q.noteReachable(false, new Map([["m1", false]]), 60_000);
    q.noteReachable(true, new Map([["m1", true]]), 62_000);
    await until(() => texts().some((x) => x.startsWith("<b>ComfyUI is offline")));
    expect(texts().filter((x) => x.startsWith("<b>ComfyUI is offline"))).toHaveLength(1);
    expect(await statusOf(id)).toBe("running");
  });
});

describe("the limits", () => {
  it("the same notice once a minute, failures folded, at most so many a minute", async () => {
    await setUp();
    const n = t.services.notify;
    n.say("comfyGone", { title: "A", body: "x", key: "m1" });
    n.say("comfyGone", { title: "A", body: "x", key: "m1" });
    await until(() => texts().length === 1);
    // three failures at once: the first at once, the two others as one message at the window's end
    n.opts.foldMs = 80;
    n.say("renderFailed", { title: "Failed: one", body: "r", key: "1" });
    n.say("renderFailed", { title: "Failed: two", body: "r", key: "2" });
    n.say("renderFailed", { title: "Failed: three", body: "r", key: "3" });
    await until(() => texts().length === 3);
    expect(texts().slice(1)).toEqual(["<b>Failed: one</b>\nr", "<b>2 more renders failed</b>\ntwo, three."]);
    // past the minute's limit: dropped, said once in the log
    const warn = vi.spyOn(console, "warn");
    n.opts.perMinute = 5;
    for (let i = 0; i < 4; i++) n.say("comfyGone", { title: `P${i}`, body: "x", key: String(i) });
    await new Promise((r) => setTimeout(r, 150));
    expect(texts()).toHaveLength(5);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("in a minute"))).toHaveLength(1);
  });

  it("a notice about money goes even past the minute's limit (20 renders done, then a cap reached)", async () => {
    await setUp({ renderDone: { telegram: true, discord: true } });
    const n = t.services.notify;
    for (let i = 0; i < 20; i++) n.say("renderDone", { title: `Done: zz-test ${i}`, body: "x", key: String(i) });
    await until(() => texts().length === 20);
    n.say("renderDone", { title: "Done: zz-test dropped", body: "x", key: "late" });
    for (const kind of ["capReached", "podStopped", "balanceLow", "huntGaveUp"] as const) n.say(kind, { title: `Money: ${kind}`, body: "x", key: kind });
    await until(() => texts().filter((x) => x.startsWith("<b>Money: ")).length === 4 && discordTexts().filter((x) => x.startsWith("**Money: ")).length === 4);
    await new Promise((r) => setTimeout(r, 50));
    expect(texts().some((x) => x.includes("dropped"))).toBe(false);
  });

  it("sends a small picture of what it is about as a photo", async () => {
    await setUp({ renderDone: { telegram: true, discord: true } });
    const id = newId();
    const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    await t.services.storage.put(`assets/${id}.png`, new Uint8Array(png));
    await t.db.insertInto("assets").values({
      id, owner_id: OWNER, kind: "image", origin: "generated", name: "zz-test", file_key: `assets/${id}.png`, thumb_key: null, mime: "image/png",
      bytes: png.length, width: 2000, height: 1000, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
    }).execute();
    t.services.notify.say("renderDone", { title: "Done: zz-test", body: "x", asset: id });
    await until(() => telegram.heard.length === 1 && discord.heard.length === 1);
    const photo = telegram.heard[0]!;
    expect(photo.url).toBe(`/bot${TOKEN}/sendPhoto`);
    expect(photo.type).toMatch(/^multipart\/form-data/);
    const jpeg = photo.body.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg).toBeGreaterThan(0);
    const size = await sharp(photo.body.subarray(jpeg)).metadata().catch(() => null);
    expect(size === null || (size.width ?? 0) <= 1280).toBe(true);
    expect(photo.body.toString("latin1")).toContain("<b>Done: zz-test</b>");
    expect(discord.heard[0]!.type).toMatch(/^multipart\/form-data/);
    expect(discord.heard[0]!.body.toString("latin1")).toContain("payload_json");
    // off: words only
    await put({ notify: { picture: false } });
    t.services.notify.say("renderDone", { title: "Done: zz-test 2", body: "x", asset: id });
    await until(() => telegram.heard.length === 2);
    expect(telegram.heard[1]!.url).toBe(`/bot${TOKEN}/sendMessage`);
  });
});

describe("what the rented GPUs tell", () => {
  const KEY = "rpa_test_key_0123456789";
  let podComfy: FakeComfy;
  let runpod: FakeRunpod;
  const startPod = async (balance?: number) => {
    podComfy = await makeFake();
    runpod = await startFakeRunpod({ key: KEY, bootMs: 50, ...(balance === undefined ? {} : { balance }), pods: [{ name: "comfy-5090", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: podComfy }] });
    vi.stubEnv("RUNPOD_API_URL", runpod.url);
    vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
    t.services.rented.everyMs = 60_000;
    await put({ runpodKey: KEY });
    const id = (await post(t.app, "/api/runpod/add", { pod: runpod.pods[0]!.id })).json().id as string;
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await t.services.rented.poll();
    return id;
  };
  afterEach(async () => {
    await Promise.all([podComfy, runpod].map((x) => x?.close().catch(() => {})));
  });

  it("a pod stopped for being idle, with why and what it cost, once; a cap reached, once", async () => {
    await setUp();
    await startPod();
    const real = Date.now;
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    await until(() => texts().some((x) => x.includes("stopped</b>")));
    expect(texts().find((x) => x.includes("stopped</b>"))).toMatch(/^<b>comfy-5090 stopped<\/b>\nWhy: idle 10 min\. This run: \$\d+\.\d\d\.$/);
    // started again and capped: the cap is told once, the stop for it too
    t.services.rented.now = real;
    await post(t.app, `/api/machines/${(await t.services.machines()).find((m) => m.machine.rented)!.machine.id}/start`, {});
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await put({ rentCaps: { day: 0.0000001, month: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    await t.services.rented.poll();
    await t.services.rented.poll();
    await until(() => texts().some((x) => x.includes("cap reached")));
    expect(texts().filter((x) => x.includes("cap reached"))).toHaveLength(1);
    expect(texts().find((x) => x.includes("cap reached"))).toMatch(/^<b>Today's cap reached: /);
    await until(() => texts().some((x) => x.includes("Why: a spending cap was reached")));
  });

  it("not when the user stops it", async () => {
    await setUp();
    const id = await startPod();
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    await t.services.rented.poll();
    await new Promise((r) => setTimeout(r, 100));
    expect(texts().filter((x) => x.includes("stopped</b>"))).toEqual([]);
  });

  it("the balance low, once until it is back above", async () => {
    await setUp();
    await startPod(1.5);
    await until(() => texts().some((x) => x.includes("RunPod balance low")));
    const real = Date.now;
    t.services.rented.now = () => real() + 61_000;
    await t.services.rented.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(texts().filter((x) => x.includes("RunPod balance low"))).toHaveLength(1);
    expect(texts().find((x) => x.includes("RunPod balance low"))).toMatch(/Under \$2\.00\. At \$0 RunPod stops every pod/);
  });
});

describe("a picture or a video sent by hand (Send to)", () => {
  const uploadPng = async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c33" } }).png().toBuffer();
    const res = await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test.png", headers: { "content-type": "image/png", "x-afflatus": "1" }, payload: png });
    return res.json().id as string;
  };
  it("goes to Telegram and to Discord as the file itself, with its name", async () => {
    await setUp();
    const id = await uploadPng();
    expect((await post(t.app, `/api/assets/${id}/share`, { channel: "telegram" })).statusCode).toBe(200);
    const sent = telegram.heard.find((h) => h.url.includes("/sendPhoto"));
    expect(sent?.url).toContain(`/bot${TOKEN}/sendPhoto`);
    expect(sent?.body.toString("latin1")).toMatch(/name="photo"; filename="zz-test/);
    expect((await post(t.app, `/api/assets/${id}/share`, { channel: "discord" })).statusCode).toBe(200);
    expect(discord.heard.at(-1)?.body.toString("latin1")).toMatch(/name="files\[0\]"; filename="zz-test/);
  });
  it("is refused where nothing is set up, or for what is not in the library", async () => {
    const id = await uploadPng();
    expect((await post(t.app, `/api/assets/${id}/share`, { channel: "telegram" })).statusCode).toBe(409);
    await setUp();
    expect((await post(t.app, `/api/assets/nothere/share`, { channel: "discord" })).statusCode).toBe(404);
  });
});
