import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { portTakes, stillRuns, type StillRuns } from "../src/comfyAlive";
import { FIRST_MACHINE, type Machine } from "../src/settings";
import { CHECKPOINT, complete, job, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A ComfyUI that answers nothing while it renders, told apart from one gone (card #196): one whose process still runs (a PC
 * paging answered nothing for minutes while it sampled on) is busy, its render followed on and never queued again, said once
 * as such; one whose process is gone is offline, its render queued again, as before.
 */

let fake: FakeComfy;
let t: TestApp;
let told: Array<{ kind: string; title: string; body: string }>;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, "other.safetensors"], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
  told = [];
  t.services.queue.tell = (kind, said) => void told.push({ kind, ...said });
  await t.services.queue.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

const statusOf = async (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const submitted = () => [...fake.prompts.keys()];
const kinds = (kind: string) => told.filter((x) => x.kind === kind);
const SWAMPED: StillRuns = { runs: true, memory: "ComfyUI holds 35.4 GB, 2.1 GB of 63.9 GB RAM free", full: true, swollen: false };

/**
 * Make the fake's ComfyUI silent, its port still open: every call fails without an answer, as one swamped (a PC paging)
 * whose requests time out. Not `fake.down`: that is a gateway saying nothing listens behind it, a process gone.
 */
async function silence(): Promise<(on: boolean) => void> {
  const client = (await t.services.comfy()).client as unknown as { fetcher: typeof fetch };
  const through = client.fetcher;
  let silent = false;
  client.fetcher = (input, init) => (silent ? Promise.reject(new DOMException("The operation timed out.", "TimeoutError")) : through(input, init));
  return (on) => void (silent = on);
}

/** A render sent to the fake ComfyUI, under way. */
async function running(): Promise<string> {
  const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
  await until(async () => submitted().length === 1 && (await statusOf(id)).status === "running" && Boolean((await statusOf(id)).resume));
  return id;
}

describe("a ComfyUI that answers nothing while it renders", () => {
  it("its process alive: not offline, not queued again, said busy once, and quiet once it answers again", async () => {
    const asked: boolean[] = [];
    t.services.queue.stillRuns = async (_m, memory) => (asked.push(memory), SWAMPED);
    const silent = await silence();
    const id = await running();
    const sent = (await statusOf(id)).attempts;
    // silent, many times the wait's offlineMs (100 ms in the tests)
    silent(true);
    await until(() => kinds("comfyBusy").length === 1);
    await new Promise((r) => setTimeout(r, 600));
    const row = await statusOf(id);
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(sent);
    expect(kinds("comfyGone")).toHaveLength(0);
    expect(kinds("comfyBusy")).toHaveLength(1);
    expect(kinds("comfyBusy")[0]!.body).toMatch(/its memory is full, the PC is paging \(ComfyUI holds 35\.4 GB, 2\.1 GB of 63\.9 GB RAM free\); the render goes on/);
    // what it holds read once per silence, its port asked at each poll after
    expect(asked[0]).toBe(true);
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.slice(1).every((m) => m === false)).toBe(true);
    // the Queue and the status bar say it, the machine not offline
    const q = (await t.app.inject({ method: "GET", url: "/api/queue" })).json();
    expect(q.machines[0].busy).toMatch(/^ComfyUI isn't answering: its memory is full/);
    expect(q.running.busy).toMatch(/the render goes on/);
    // the page's poll silent 30 s on top: still busy, never offline
    t.services.queue.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 1_000);
    t.services.queue.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 40_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(kinds("comfyGone")).toHaveLength(0);
    // it answers again: no longer busy, and its render is the one it made, sent once
    silent(false);
    await until(() => t.services.queue.swampedSaid(FIRST_MACHINE) === null);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect(submitted()).toHaveLength(1);
    expect((await statusOf(id)).attempts).toBe(sent);
    expect(kinds("comfyBusy")).toHaveLength(1);
    expect(kinds("comfyGone")).toHaveLength(0);
  });

  it("its process gone (its port closed): offline, and queued again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await running();
    // the real look: nothing listens on its port any more
    await fake.close();
    // taken as lost: no longer running there (queued again, then failed by the tests' short offline expiry, as before)
    await until(async () => (await statusOf(id)).status !== "running");
    expect(["queued", "failed"]).toContain((await statusOf(id)).status);
    await until(() => kinds("comfyGone").length === 1);
    expect(kinds("comfyBusy")).toHaveLength(0);
    expect(t.services.queue.swampedSaid(FIRST_MACHINE)).toBeNull();
  });

  it("a gateway in front of it saying nothing listens behind it (502): gone, whatever else is asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.services.queue.stillRuns = async () => SWAMPED;
    const id = await running();
    fake.down = true;
    await until(async () => (await statusOf(id)).status !== "running");
    await until(() => kinds("comfyGone").length === 1);
    expect(kinds("comfyBusy")).toHaveLength(0);
  });

  it("silent to the page's poll 30 s, its process alive: said busy, not offline; gone: offline", async () => {
    let still: StillRuns = SWAMPED;
    t.services.queue.stillRuns = async () => still;
    await running();
    const q = t.services.queue;
    q.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 1_000);
    q.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 40_000);
    await until(() => kinds("comfyBusy").length === 1);
    expect(kinds("comfyGone")).toHaveLength(0);
    // back: silenced; silent again, its process gone this time
    q.noteReachable(true, new Map([[FIRST_MACHINE, true]]), 41_000);
    expect(q.swampedSaid(FIRST_MACHINE)).toBeNull();
    still = { runs: false, memory: null, full: false, swollen: false };
    q.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 42_000);
    q.noteReachable(false, new Map([[FIRST_MACHINE, false]]), 80_000);
    await until(() => kinds("comfyGone").length === 1);
    expect(kinds("comfyBusy")).toHaveLength(1);
  });
});

describe("whether a ComfyUI's process still runs (comfyAlive.ts)", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });
  /** A port that takes connections and never answers a byte: a process swamped. */
  const listening = async () => {
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  /** A port nothing listens on: a process gone. */
  const closed = async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  };
  const machine = (url: string, rented?: Machine["rented"]): Machine => ({ id: "m9", name: "zz-test", url, dir: "", dirCleared: "", takes: "all", packs: "ask", families: {}, token: "", ...(rented ? { rented } : {}) });

  it("a port that takes a connection runs, one refused does not", async () => {
    expect(await portTakes(`http://127.0.0.1:${await listening()}`)).toBe(true);
    expect(await portTakes(`http://127.0.0.1:${await closed()}`)).toBe(false);
    const away = await stillRuns(machine(`http://127.0.0.1:${await closed()}`), null, false);
    expect(away.runs).toBe(false);
    const here = await stillRuns(machine(`http://127.0.0.1:${await listening()}`), null, false);
    expect(here).toEqual({ runs: true, memory: null, full: false, swollen: false });
  });

  it("a pod by RunPod's word, never by its address (RunPod's proxy takes a connection either way)", async () => {
    const url = `http://127.0.0.1:${await listening()}`;
    const rented = { podId: "zz-test" } as unknown as NonNullable<Machine["rented"]>;
    expect((await stillRuns(machine(url, rented), () => false)).runs).toBe(false);
    expect((await stillRuns(machine(url, rented), () => true)).runs).toBe(true);
    expect((await stillRuns(machine(url, rented), null)).runs).toBe(false);
  });

  it("an address out there is not looked at: it may be a proxy", async () => {
    expect((await stillRuns(machine("https://comfy.example.com"), null, false)).runs).toBe(false);
  });
});
