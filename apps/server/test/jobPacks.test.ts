import { afterEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { NodeCatalog, Wanted } from "@afflatus/core";
import { asBuilt, lookAhead, packFacts, packsLacked, ranWithoutSaid } from "../src/jobPacks";
import { writeSettings, readSettings } from "../src/settings";
import { CHECKPOINT, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A node pack a render asks for is installed where it runs (the owner, 2026-10-20): the job waits there for it, installed
 * when the machine's rule says Always or its Queue row says Install and restart, ComfyUI restarted once nothing renders; one
 * that cannot come (no Manager, Run without, a card that cannot run it) is done without, and the job says so.
 */

const node = (n: string) => ({ input: { required: {} }, output: [], output_name: [], name: n, category: "x" });
const VEDA: Wanted = { input: "veda", nodes: ["VedaSparseAttention"], without: "Veda", instead: "made with the full attention" };
const RTX: Wanted = { input: "upscale", nodes: ["RTXVideoSuperResolution", "DaSiWa_RTX_UpscalerRefiner"], without: "RTX VSR", instead: "a plain resize instead" };

describe("what a render asks for, looked at ahead", () => {
  const empty = {} as NodeCatalog;

  it("gives an option the node its pack brings, and records it; one the machine has is its own", () => {
    const ahead = lookAhead(empty);
    expect(ahead.wants(VEDA)).toBe("VedaSparseAttention");
    // RTX VSR asks for DaSiWa's pack, the last of its drivers
    expect(ahead.wants(RTX)).toBe("DaSiWa_RTX_UpscalerRefiner");
    expect(ahead.missing.map((w) => w.input)).toEqual(["veda", "upscale"]);
    expect(lookAhead({ RTXVideoSuperResolution: node("x") } as never).wants(RTX)).toBe("RTXVideoSuperResolution");
  });

  it("does without what cannot come: no Manager, Run without, a card that cannot run it", () => {
    const noManager = lookAhead(empty, packFacts("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", false, new Map(), "Studio PC"));
    expect(noManager.wants(VEDA)).toBeNull();
    expect(noManager.skipped[0]!.why).toBe("no ComfyUI-Manager on Studio PC to install it");
    expect(lookAhead(empty, packFacts(null, true, new Map(), "x"), { without: ["veda-sparse-attention"] }).wants(VEDA)).toBeNull();
    const amd = lookAhead(empty, packFacts("AMD Radeon RX 7900 XTX", true, new Map(), "x"));
    expect(amd.wants(RTX)).toBeNull();
    expect(amd.wants(VEDA)).toBe("VedaSparseAttention");
    expect(lookAhead(empty, packFacts(null, true, new Map([["veda-sparse-attention", "ComfyUI-Manager refused it (403)"]]), "x")).wants(VEDA)).toBeNull();
  });

  it("says on the job what it ran without, and why", () => {
    const built = asBuilt(empty, packFacts(null, false, new Map(), "Studio PC"));
    expect(built.wants(VEDA)).toBeNull();
    expect(ranWithoutSaid(built.without[0]!.w, built.without[0]!.why)).toBe("Ran without Veda (made with the full attention): its node pack veda-sparse-attention is missing, no ComfyUI-Manager on Studio PC to install it.");
    expect(ranWithoutSaid(VEDA, "run without it, as asked")).toBe("Ran without Veda (made with the full attention): run without it, as asked.");
  });

  it("tells an option's packs, which it can do without, from those it cannot run without", () => {
    const lacked = packsLacked({ missingNodes: ["VedaSparseAttention", "UnetLoaderGGUF", "SomeNodeNobodyHas"], wanted: [VEDA] });
    expect(lacked).toEqual({ soft: [{ pack: "veda-sparse-attention", without: "Veda" }], hard: ["comfyui-gguf"], unknown: ["SomeNodeNobodyHas"] });
  });
});

// a machine of your own without DaSiWa's pack (H3's Cache), with a Manager that installs it and a restart that loads it
const FILES = {
  checkpoints: [CHECKPOINT],
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  upscale_models: [],
};
const DASIWA = ["DaSiWa_RTX_UpscalerRefiner", "MiniMaxH3Cache"];
const CACHED = { description: "a cat on a wall", seconds: 5, fast: false, cache: true };

let fake: FakeComfy;
let t: TestApp;
afterEach(async () => {
  await t?.close();
  await fake?.close().catch(() => {});
});

async function setUp(opts: { manager?: boolean; rule?: "ask" | "always" } = {}) {
  const all = referenceCatalog();
  const catalog = Object.fromEntries(Object.entries(all).filter(([n]) => !DASIWA.includes(n)));
  // the restart loads the pack's nodes as they really are
  fake = await startFakeComfy({ catalog, models: FILES, manager: opts.manager ?? true, afterReboot: Object.fromEntries(DASIWA.map((n) => [n, all[n]!])) });
  t = await makeApp({ comfyUrl: fake.url });
  if (opts.rule) {
    const s = await readSettings(t.db);
    await writeSettings(t.db, { machines: s.machines.map((m) => ({ ...m, packs: opts.rule! })) });
  }
}
/**
 * Waits on what the queue's view says, read every 100 ms: each read builds the whole view, and read every 5 ms (until's
 * default) it starved the pod tests running beside these (podQueue's pod files never came in time).
 */
const slowly = (check: () => Promise<boolean>, ms = 15_000) => until(check, ms, 100);
const queueOf = async () => (await t.app.inject({ method: "GET", url: "/api/queue" })).json() as { waiting: Array<{ id: string; packs: { state: string; packs: Array<{ name: string; without?: string }> } | null }> };
const sentNodes = () => [...fake.prompts.values()].flatMap((g) => Object.values(g as Record<string, { class_type: string }>).map((n) => n.class_type));
const warningOf = async (id: string) => (await t.db.selectFrom("jobs").select("warning").where("id", "=", id).executeTakeFirst())?.warning ?? "";

describe("a node pack a render asks for, on a ComfyUI of your own", () => {
  it("Ask: the job waits, its row offers Install and restart and Run without; nothing is sent meanwhile", async () => {
    await setUp();
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    expect((await queueOf()).waiting[0]!.packs!.packs).toEqual([{ name: "ComfyUI-DaSiWa-Nodes", without: "H3's Cache" }]);
    expect(fake.prompts.size).toBe(0);
    expect(fake.reboots).toBe(0);
    // its form says so under the Cache switch
    const form = (await post(t.app, "/api/form/packs", { recipe: "h3.video", input: CACHED })).json();
    expect(form).toMatchObject({ rule: "ask", notes: [{ input: "cache", pack: "ComfyUI-DaSiWa-Nodes", state: "comes", without: "H3's Cache" }] });
    expect((await post(t.app, `/api/jobs/${id}/packs`, { do: "nothing", packs: ["x"] })).statusCode).toBe(400);
  });

  it("Install and restart: installed by Manager, ComfyUI restarted once free, then the job renders with the node", async () => {
    await setUp();
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    expect((await post(t.app, `/api/jobs/${id}/packs`, { do: "install", packs: ["ComfyUI-DaSiWa-Nodes"] })).statusCode).toBe(200);
    await until(() => fake.packs.some((p) => p.id === "ComfyUI-DaSiWa-Nodes"), 15_000);
    await until(() => fake.reboots === 1, 15_000);
    await until(() => fake.prompts.size === 1, 20_000);
    expect(sentNodes()).toContain("MiniMaxH3Cache");
    expect(await warningOf(id)).not.toContain("Ran without");
  }, 40_000);

  it("Run without: renders at once without the node, and says so on the job", async () => {
    await setUp();
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    await post(t.app, `/api/jobs/${id}/packs`, { do: "without", packs: ["ComfyUI-DaSiWa-Nodes"] });
    await until(() => fake.prompts.size === 1);
    expect(sentNodes()).not.toContain("MiniMaxH3Cache");
    await until(async () => (await warningOf(id)).includes("Ran without H3's Cache: run without it, as asked."));
    expect(fake.packs).toEqual([]);
    expect(fake.reboots).toBe(0);
  });

  it("no ComfyUI-Manager: renders without it, never refused, and says why", async () => {
    await setUp({ manager: false });
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await until(() => fake.prompts.size === 1);
    expect(sentNodes()).not.toContain("MiniMaxH3Cache");
    await until(async () => /Ran without H3's Cache: its node pack ComfyUI-DaSiWa-Nodes is missing, no ComfyUI-Manager on .+ to install it\./.test(await warningOf(id)));
    const form = (await post(t.app, "/api/form/packs", { recipe: "h3.video", input: CACHED })).json();
    expect(form.notes[0]).toMatchObject({ input: "cache", state: "cannot", why: expect.stringContaining("no ComfyUI-Manager") });
  });

  it("Always: installed without asking", async () => {
    await setUp({ rule: "always" });
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED });
    await until(() => fake.packs.some((p) => p.id === "ComfyUI-DaSiWa-Nodes"), 15_000);
    await until(() => fake.prompts.size === 1, 20_000);
    expect(sentNodes()).toContain("MiniMaxH3Cache");
  }, 40_000);

  it("a job that asks for no pack goes as before, past one that waits for its click", async () => {
    await setUp();
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED });
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { ...CACHED, cache: false } });
    await until(() => fake.prompts.size === 1);
    expect(sentNodes()).not.toContain("MiniMaxH3Cache");
  });
});

describe("a node pack a render asks for, with several machines", () => {
  let second: FakeComfy;
  afterEach(async () => {
    await second?.close().catch(() => {});
  });

  it("goes to the machine that has it; pinned to one without it, waits there for it", async () => {
    await setUp();
    second = await startFakeComfy({ catalog: referenceCatalog(), models: FILES });
    const s = await readSettings(t.db);
    await writeSettings(t.db, { machines: [s.machines[0]!, { ...s.machines[0]!, id: "m2", name: "Second GPU", url: second.url }] });
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED });
    await until(() => second.prompts.size === 1, 15_000);
    expect(fake.prompts.size).toBe(0);
    // its form, read for the first machine, says the second has it
    const form = (await post(t.app, "/api/form/packs", { recipe: "h3.video", input: CACHED })).json();
    expect(form.notes[0]).toMatchObject({ input: "cache", state: "comes", has: ["Second GPU"] });
    // pinned to the first, it waits there, asking
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED, machine: s.machines[0]!.id });
    await slowly(async () => (await queueOf()).waiting.some((w) => w.packs?.state === "ask"), 15_000);
    expect(fake.prompts.size).toBe(0);
  }, 40_000);
});
