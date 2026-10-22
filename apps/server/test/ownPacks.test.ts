import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Downloads } from "../src/downloads";
import { Recent } from "../src/jobFiles";
import { packFacts } from "../src/jobPacks";
import { PodPacks } from "../src/podPacks";
import { OwnPacks, packsToWant } from "../src/queuePacks";
import type { Comfy } from "../src/comfy";
import type { Lane } from "../src/queueModel";

/**
 * The node packs of a ComfyUI of the user's own, where they fail, wait or restart it (review of 0.6.0, N-1 to N-10): a pack
 * that failed is tried again after a while, Ask holds pack by pack, "did not answer" is not "no Manager", a restart waits for
 * what runs in ComfyUI and for no job that does not want it, and AMD cards are not taken for NVIDIA's.
 */

/** A pretend ComfyUI as PodPacks reads it: Manager's install queue and history, its own queue, its restart. */
function stubComfy(o: { result?: (id: string) => string; queue?: () => { running: unknown[]; pending: unknown[] }; noAnswer?: boolean } = {}) {
  const tasks: Array<{ ui_id: string; id: string }> = [];
  const history: Record<string, { result: string }> = {};
  let reboots = 0;
  let queueReads = 0;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  const client = {
    baseUrl: "http://stub",
    raw: async (path: string, init?: RequestInit) => {
      if (o.noAnswer) throw new TypeError("fetch failed");
      if (path === "/v2/manager/queue/task") {
        const t = JSON.parse(String(init!.body)) as { ui_id: string; params: { id: string } };
        tasks.push({ ui_id: t.ui_id, id: t.params.id });
        return new Response("", { status: 200 });
      }
      if (path === "/v2/manager/queue/start") {
        for (const t of tasks.splice(0)) history[t.ui_id] = { result: o.result?.(t.id) ?? "success" };
        return new Response("", { status: 200 });
      }
      if (path.startsWith("/v2/manager/queue/history")) return json({ history });
      if (path === "/v2/manager/reboot") {
        reboots++;
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 404 });
    },
    status: async () => ({}),
    queue: async () => {
      queueReads++;
      return o.queue?.() ?? { running: [], pending: [] };
    },
  };
  const comfy = { client, forgetAll: () => {} } as unknown as Comfy;
  return { comfy, get reboots() { return reboots; }, get queueReads() { return queueReads; } };
}

const lane = (comfy: Comfy, more: Partial<Lane> = {}) => ({ id: "own", machine: { id: "own", name: "Studio PC", packs: "ask" }, comfy, device: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", running: null, starting: null, outside: null, ...more }) as unknown as Lane;

/** PodPacks passes until nothing moves (installs asked, followed, restarted). */
async function settle(packs: PodPacks, machine: string, times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await packs.pass(machine);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a pack whose install failed on a ComfyUI of your own", () => {
  it("cannot come for AGAIN_MS, then may again: a job asking for it has it tried again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    let refuse = true;
    const stub = stubComfy({ result: () => (refuse ? "failed" : "success") });
    const l = lane(stub.comfy);
    const own = new OwnPacks({ lane: () => l, manager: async () => true, changed: () => {} });
    own.packs.want("own", ["veda-sparse-attention"], "job-1");
    await settle(own.packs, "own");
    expect(own.packs.view("own")[0]).toMatchObject({ state: "failed" });
    expect((await own.facts(l)).cannot.has("veda-sparse-attention")).toBe(true);
    // 29 minutes on, still failed; past 30, it may come again, and a job's want re-arms it
    vi.setSystemTime(new Date("2026-10-22T10:29:00Z"));
    expect((await own.facts(l)).cannot.has("veda-sparse-attention")).toBe(true);
    vi.setSystemTime(new Date("2026-10-22T10:31:00Z"));
    expect((await own.facts(l)).cannot.has("veda-sparse-attention")).toBe(false);
    refuse = false;
    expect(own.packs.want("own", ["veda-sparse-attention"], "job-2")).toBe(true);
    await settle(own.packs, "own");
    expect(stub.reboots).toBe(1);
    own.stop();
  });
});

describe("Ask, pack by pack", () => {
  it("another job's install brings that pack only, never the job's others unasked", () => {
    const names = ["ComfyUI-DaSiWa-Nodes", "comfyui-gguf"];
    const underWay = new Set(["ComfyUI-DaSiWa-Nodes"]);
    expect(packsToWant(names, { unasked: false, said: {}, underWay })).toEqual(["ComfyUI-DaSiWa-Nodes"]);
    expect(packsToWant(names, { unasked: false, said: { install: ["comfyui-gguf"] }, underWay })).toEqual(names);
    expect(packsToWant(names, { unasked: true, said: {}, underWay: new Set() })).toEqual(names);
    expect(packsToWant(names, { unasked: false, said: {}, underWay: new Set() })).toEqual([]);
  });
});

describe("whether a ComfyUI has ComfyUI-Manager", () => {
  it("is not known when it does not answer (not \"none\"), and is asked again soon", async () => {
    const downloads = new Downloads(new EventEmitter());
    let answer: "none" | "down" | "there" = "down";
    const comfy = { client: { baseUrl: "http://stub-manager", raw: async () => {
      if (answer === "down") throw new TypeError("fetch failed");
      return new Response(answer === "there" ? "V4.2.1" : "", { status: answer === "there" ? 200 : 404 });
    } } } as unknown as Comfy;
    expect(await downloads.manager(comfy)).toEqual({ found: false, unknown: true });
    // the queue reads it as "may come", not as "no Manager on Studio PC"
    expect(packFacts(null, null, new Map(), "Studio PC").cannot.size).toBe(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6000);
    answer = "there";
    expect(await downloads.manager(comfy)).toEqual({ found: true, version: "V4.2.1" });
    const other = { client: { baseUrl: "http://stub-none", raw: async () => new Response("", { status: 404 }) } } as unknown as Comfy;
    expect(await downloads.manager(other)).toEqual({ found: false });
  });
});

describe("ComfyUI restarted for packs", () => {
  it("waits for a prompt its own queue has now, read live, and for a job Afflatus started meanwhile", async () => {
    let pending: unknown[] = [["x"]];
    const stub = stubComfy({ queue: () => ({ running: [], pending }) });
    let starting = false;
    const packs = new PodPacks({ comfyOf: async () => stub.comfy, busy: () => starting });
    packs.want("m", ["comfyui-gguf"], "job-1");
    await settle(packs, "m");
    expect(packs.view("m")[0]!.state).toBe("installed");
    expect(packs.holding("m")).toBe(true);
    expect(stub.reboots).toBe(0);
    // its queue empty, but a job started while it was read: still not
    pending = [];
    const read = stub.comfy.client.queue.bind(stub.comfy.client);
    (stub.comfy.client as unknown as { queue: () => Promise<unknown> }).queue = async () => {
      starting = true;
      return read();
    };
    await packs.pass("m");
    expect(stub.reboots).toBe(0);
    (stub.comfy.client as unknown as { queue: () => Promise<unknown> }).queue = read;
    starting = false;
    await packs.pass("m");
    expect(stub.reboots).toBe(1);
  });

  it("waits for a download of Afflatus's that runs in that ComfyUI", async () => {
    let downloading = true;
    const stub = stubComfy();
    const l = lane(stub.comfy);
    const own = new OwnPacks({ lane: () => l, manager: async () => true, changed: () => {}, downloading: () => downloading });
    own.packs.want("own", ["comfyui-gguf"], "job-1");
    await settle(own.packs, "own");
    expect(stub.reboots).toBe(0);
    downloading = false;
    await own.packs.pass("own");
    expect(stub.reboots).toBe(1);
    own.stop();
  });

  it("not for a pack whose jobs were cancelled, or said Run without: the machine is free again", async () => {
    const stub = stubComfy();
    const l = lane(stub.comfy);
    const own = new OwnPacks({ lane: () => l, manager: async () => true, changed: () => {} });
    own.keepOnly([{ id: "job-1", packs: null }]);
    own.packs.want("own", ["comfyui-gguf"], "job-1");
    // being installed when the job goes: left to finish, but ComfyUI is not restarted for it
    await own.packs.pass("own");
    expect(own.packs.view("own")[0]!.state).toBe("installing");
    own.keepOnly([]);
    await settle(own.packs, "own");
    expect(stub.reboots).toBe(0);
    expect(own.holding("own")).toBe(false);
    // installed and waiting for the machine to be free: Run without frees it
    l.running = {} as never;
    own.keepOnly([{ id: "job-2", packs: null }]);
    own.packs.want("own", ["veda-sparse-attention"], "job-2");
    await settle(own.packs, "own");
    expect(own.holding("own")).toBe(true);
    own.keepOnly([{ id: "job-2", packs: JSON.stringify({ without: ["veda-sparse-attention"] }) }]);
    expect(own.holding("own")).toBe(false);
    l.running = null;
    await settle(own.packs, "own");
    expect(stub.reboots).toBe(0);
    own.stop();
  });
});

describe("a pack ComfyUI-Manager cannot find in its list", () => {
  const notFound = (id: string) => `Cannot resolve install target: '${id}@latest'`;

  it("on a ComfyUI of your own: failed at once, saying how to have it by hand", async () => {
    const stub = stubComfy({ result: notFound });
    const l = lane(stub.comfy);
    const own = new OwnPacks({ lane: () => l, manager: async () => true, changed: () => {} });
    own.packs.want("own", ["comfyui-h3-facerefine"], "job-1");
    await settle(own.packs, "own", 2);
    expect(own.packs.view("own")[0]).toMatchObject({ state: "failed", error: expect.stringContaining("clone https://github.com/Carasibana/ComfyUI-H3-FaceRefine into ComfyUI's custom_nodes folder") });
    own.stop();
  });

  it("on a pod: asked again while Manager's list may still load, not once another pack was found in it", async () => {
    const stub = stubComfy({ result: (id) => (id === "comfyui-h3-facerefine" ? notFound(id) : "success") });
    const packs = new PodPacks({ comfyOf: async () => stub.comfy, busy: () => true });
    packs.retryMs = 0;
    packs.want("pod", ["comfyui-h3-facerefine"], "job-1");
    await settle(packs, "pod", 2);
    expect(packs.view("pod")[0]!.state).not.toBe("failed");
    packs.want("pod", ["comfyui-gguf"], "job-2");
    await settle(packs, "pod", 6);
    expect(packs.view("pod").find((e) => e.name === "comfyui-gguf")!.state).toBe("installed");
    expect(packs.view("pod").find((e) => e.name === "comfyui-h3-facerefine")!.state).toBe("failed");
  });
});

describe("the card a ComfyUI runs on", () => {
  it("is an NVIDIA RTX one only by its name: ROCm and ZLUDA's \"cuda\" AMD cards and a GTX are not", () => {
    expect(packFacts("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(true);
    expect(packFacts("cuda:0 NVIDIA RTX A6000 : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(true);
    expect(packFacts("cuda:0 AMD Radeon RX 7900 XTX : native", true, new Map(), "x").nvidia).toBe(false);
    expect(packFacts("cuda:0 NVIDIA GeForce GTX 1080 Ti : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(false);
    // the data-centre cards of the RTX generations have no "RTX" in their name: an A40 ran RTX VSR on a pod
    expect(packFacts("cuda:0 NVIDIA A40 : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(true);
    expect(packFacts("cuda:0 NVIDIA L40S : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(true);
    expect(packFacts("cuda:0 Tesla V100-SXM2-16GB : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(false);
    expect(packFacts("cuda:0 Quadro P4000 : cudaMallocAsync", true, new Map(), "x").nvidia).toBe(false);
  });
});

describe("the look-ahead kept", () => {
  it("drops the least recently used, not the oldest: one read often stays", () => {
    const kept = new Recent<string, number>(2);
    kept.set("a", 1);
    kept.set("b", 2);
    expect(kept.get("a")).toBe(1);
    kept.set("c", 3);
    expect([...kept.keys()].sort()).toEqual(["a", "c"]);
    expect(kept.size).toBe(2);
  });
});
