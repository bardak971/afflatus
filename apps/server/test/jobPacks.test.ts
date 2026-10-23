import { afterEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { nodesOfPack, type NodeCatalog, type Wanted } from "@afflatus/core";
import { UPSCALE } from "@afflatus/recipes";
import { asBuilt, lookAhead, packFacts, packsLacked, packsSaid, ranWithoutSaid } from "../src/jobPacks";
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
    expect(lacked).toEqual({ soft: [{ pack: "veda-sparse-attention", without: "Veda" }], hard: ["ComfyUI-GGUF"], unknown: ["SomeNodeNobodyHas"] });
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

async function setUp(opts: { manager?: boolean; rule?: "ask" | "always"; lacks?: string[]; models?: Record<string, string[]>; loads?: string[] } = {}) {
  const all = referenceCatalog();
  const lacks = [...DASIWA, ...(opts.lacks ?? [])];
  const catalog = Object.fromEntries(Object.entries(all).filter(([n]) => !lacks.includes(n)));
  // the restart loads the pack's nodes as they really are (`loads`: other packs' nodes it loads too)
  fake = await startFakeComfy({ catalog, models: opts.models ?? FILES, manager: opts.manager ?? true, afterReboot: Object.fromEntries([...DASIWA, ...(opts.loads ?? [])].map((n) => [n, all[n]!])) });
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

  it("a form with no media yet (Lip sync with no recording) says the pack its options need all the same (card #50)", async () => {
    await setUp();
    const form = await post(t.app, "/api/form/packs", { recipe: "h3.lipsync", input: { description: "a cat on a wall", fast: false, cache: true } });
    expect(form.statusCode).toBe(200);
    expect(form.json()).toMatchObject({ notes: [{ input: "cache", pack: "ComfyUI-DaSiWa-Nodes", state: "comes" }] });
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

  it("a pack it loaded, gone from its node list since: asked for again, never waited for under \"installed\" (review of 0.6.0, N-19)", async () => {
    await setUp();
    const first = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    await post(t.app, `/api/jobs/${first}/packs`, { do: "install", packs: ["ComfyUI-DaSiWa-Nodes"] });
    await until(() => fake.prompts.size === 1, 20_000);
    expect((await post(t.app, `/api/jobs/${first}/cancel`)).statusCode).toBe(200);
    // the pack taken out of custom_nodes and ComfyUI restarted by hand: its socket opens again, its node list is read anew
    for (const n of DASIWA) delete (fake.catalog as Record<string, unknown>)[n];
    fake.dropSockets();
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED });
    await slowly(async () => (await queueOf()).waiting.some((w) => w.packs?.state === "ask"));
    expect(fake.prompts.size).toBe(1);
  }, 40_000);

  it("cancelled while ComfyUI restarts for its pack: the restart is followed, and the next job renders (review 0.6.0, N-15)", async () => {
    await setUp();
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    await post(t.app, `/api/jobs/${id}/packs`, { do: "install", packs: ["ComfyUI-DaSiWa-Nodes"] });
    await until(() => fake.reboots === 1, 15_000);
    expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { ...CACHED, cache: false } });
    await until(() => fake.prompts.size === 1, 20_000);
    expect(fake.reboots).toBe(1);
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

  it("Ask, two jobs, one said Install: the other gets that pack, never its other pack unasked, and still asks", async () => {
    // packsToWant was tested alone (review O-12): this goes through OwnPacks.mayStart with a second job under way (N-2).
    await setUp({ lacks: ["VedaSparseAttention"], models: { ...FILES, veda: ["minimax_h3_r2va_veda_preview_fp8.safetensors", "minimax_h3_t2va_veda_preview_fp8.safetensors"] } });
    const first = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    const second = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { ...CACHED, veda: true } })).json().ids[0] as string;
    const rowOf = async (id: string) => (await queueOf()).waiting.find((w) => w.id === id)?.packs;
    await slowly(async () => (await rowOf(first))?.state === "ask" && (await rowOf(second))?.state === "ask");
    expect((await rowOf(second))!.packs.map((p) => p.name).sort()).toEqual(["ComfyUI-DaSiWa-Nodes", "veda-sparse-attention"]);
    await post(t.app, `/api/jobs/${first}/packs`, { do: "install", packs: ["ComfyUI-DaSiWa-Nodes"] });
    await until(() => fake.prompts.size === 1, 20_000);
    // The first job renders with the pack it asked for; the second still asks, and nothing brought its Veda pack unasked.
    expect((await rowOf(second))?.state).toBe("ask");
    expect(fake.packs.map((p) => p.id)).toEqual(["ComfyUI-DaSiWa-Nodes"]);
  }, 40_000);

  for (const rule of ["ask", "always"] as const) {
    it(`an older copy of the pack on the disk, the restart bringing nothing new (${rule}): failed with how to update it, the job runs without, ComfyUI not restarted again (review of 0.6.0, N-20)`, async () => {
      // DaSiWa's pack before its H3 Cache: its first node answers after the restart, the one the job lacked does not.
      // Counted loaded by that first node, the job waited for good under "installed"
      const all = referenceCatalog();
      const catalog = Object.fromEntries(Object.entries(all).filter(([n]) => n !== "MiniMaxH3Cache"));
      fake = await startFakeComfy({ catalog, models: FILES, manager: true, afterReboot: {} });
      t = await makeApp({ comfyUrl: fake.url });
      const s = await readSettings(t.db);
      await writeSettings(t.db, { machines: s.machines.map((m) => ({ ...m, packs: rule })) });
      const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
      if (rule === "ask") {
        await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
        await post(t.app, `/api/jobs/${id}/packs`, { do: "install", packs: ["ComfyUI-DaSiWa-Nodes"] });
      }
      await until(() => fake.reboots === 1, 15_000);
      await until(() => fake.prompts.size === 1, 20_000);
      expect(sentNodes()).not.toContain("MiniMaxH3Cache");
      await until(async () => (await warningOf(id)).includes("update ComfyUI-DaSiWa-Nodes (its version lacks MiniMaxH3Cache)"));
      expect(await warningOf(id)).toContain("git pull");
      expect(fake.reboots).toBe(1);
    }, 40_000);
  }

  it("a job that asks for no pack goes as before, past one that waits for its click", async () => {
    await setUp();
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED });
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { ...CACHED, cache: false } });
    await until(() => fake.prompts.size === 1);
    expect(sentNodes()).not.toContain("MiniMaxH3Cache");
  });
});

describe("a node pack a render cannot run without, on the only ComfyUI of your own (review of 0.6.0, N-17)", () => {
  // This PC lacks the pack: the job was refused "Install it in ComfyUI", never offered Install, while its form said the
  // queue asks for it. Nor are the packs of its "use if present" routes (KJNodes, VHS) asked for, which it runs without.
  const GGUF = "minimax_h3_fl2va-Q5_K_M.gguf";
  const OPTIONAL = [...nodesOfPack("comfyui-kjnodes"), ...nodesOfPack("comfyui-videohelpersuite")];

  async function installed(pack: string, input: Record<string, unknown>) {
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input })).json().ids[0] as string;
    await slowly(async () => (await queueOf()).waiting[0]?.packs?.state === "ask");
    expect((await queueOf()).waiting[0]!.packs!.packs).toEqual([{ name: pack }]);
    expect(fake.prompts.size).toBe(0);
    expect((await post(t.app, `/api/jobs/${id}/packs`, { do: "install", packs: [pack] })).statusCode).toBe(200);
    await until(() => fake.reboots === 1, 15_000);
    await until(() => fake.prompts.size === 1, 20_000);
    expect(fake.packs.map((p) => p.id)).toEqual([pack]);
  }

  it("a .gguf model without ComfyUI-GGUF: Install and restart, then it renders with the GGUF loader", async () => {
    const GGUF_NODES = nodesOfPack("ComfyUI-GGUF");
    await setUp({ lacks: [...GGUF_NODES, ...OPTIONAL], loads: GGUF_NODES, models: { ...FILES, unet_gguf: [GGUF] } });
    await installed("ComfyUI-GGUF", { ...CACHED, cache: false, model: GGUF });
    expect(sentNodes()).toContain("UnetLoaderGGUF");
  }, 40_000);

  it("a latent finish without the MMH3 pack: Install and restart, then it renders with its nodes", async () => {
    const MMH3 = nodesOfPack("Comfyui-MMH3-UltimateUpscale");
    await setUp({ lacks: [...MMH3, ...OPTIONAL], loads: MMH3, models: { ...FILES, latent_upscale_models: ["minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors"], frame_interpolation: ["rife_v4.26.safetensors"] } });
    await installed("Comfyui-MMH3-UltimateUpscale", { ...CACHED, cache: false, upscale: UPSCALE.latent });
    expect(sentNodes()).toContain("MMH3UltimateUpscale");
  }, 40_000);
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

describe("a job's saved choice about its packs", () => {
  it("holds for a pack renamed to the Registry's spelling since it was saved (comfyui-gguf → ComfyUI-GGUF)", () => {
    expect(packsSaid({ packs: JSON.stringify({ install: ["comfyui-gguf"], without: ["veda-sparse-attention"] }) })).toEqual({ install: ["ComfyUI-GGUF"], without: ["veda-sparse-attention"] });
    expect(packsSaid({ packs: null })).toEqual({});
  });
});
