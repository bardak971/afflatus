import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comfy } from "../src/comfy";

/**
 * What Afflatus writes itself is handed to a stand-in of fetchToFile: each test says when the file is "fetched", and what
 * happens meanwhile (a second start, a stop).
 */
type Fetched = { dest: string; signal: AbortSignal; takeOver?: boolean; keepPart?: boolean; reserved?: () => number };
const fetched = vi.hoisted(() => ({ run: async (_o: Fetched) => {} }));
vi.mock("../src/modelDownload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modelDownload")>()),
  fetchToFile: (o: Fetched) => fetched.run(o),
}));
const { Downloads } = await import("../src/downloads");
const { Passing } = await import("../src/modelDownload");
const { until } = await import("./helpers");

/** Starts and stops that land at the same time as something else: a second start, a stop after the file was named, a restart. */
describe("downloads, at the same time as something else", () => {
  let dir = "";
  let loras = "";
  let listed: string[] = [];
  let folderAsks = 0;
  let made: InstanceType<typeof Downloads>[] = [];
  const was = process.env.CIVITAI_URL;
  // ComfyUI on this machine, its loras in a folder of the test's
  const stub = (port = 1) => ({
    url: `http://127.0.0.1:${port}`,
    client: {
      baseUrl: `http://127.0.0.1:${port}`,
      raw: async (path: string) => {
        if (path !== "/internal/folder_paths") return new Response("", { status: 404 });
        folderAsks++;
        // a ComfyUI a moment slow to answer: two starts at once are both past the first look at the list meanwhile
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ loras: [loras] }));
      },
      packVersion: async () => null,
      models: async () => listed,
    },
    forgetFiles() {},
  }) as unknown as Comfy;
  const open = (file?: string) => {
    const d = new Downloads(new EventEmitter(), file);
    d.listedEveryMs = 5;
    made.push(d);
    return d;
  };
  const want = { file: "a.safetensors", folder: "loras", title: "A", source: "http://127.0.0.1:1/a.safetensors" };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-races-"));
    loras = join(dir, "loras");
    mkdirSync(loras);
    listed = [];
    folderAsks = 0;
    process.env.CIVITAI_URL = "http://127.0.0.1:1";
    fetched.run = async (o) => {
      writeFileSync(o.dest, "x");
    };
  });
  afterEach(async () => {
    for (const d of made) {
      for (const v of d.list()) d.stop(v.id);
      await d.flushed();
    }
    made = [];
    if (was === undefined) delete process.env.CIVITAI_URL;
    else process.env.CIVITAI_URL = was;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("starts the same file to the same ComfyUI once when it is asked twice at once (a double click, two tabs)", async () => {
    let release = () => {};
    fetched.run = () => new Promise((r) => (release = () => r(undefined)));
    const d = open();
    const comfy = stub();
    const [a, b] = await Promise.all([d.start(comfy, "http://127.0.0.1:2", want), d.start(comfy, "http://127.0.0.1:2", want)]);
    expect(b.id).toBe(a.id);
    expect(d.list().map((v) => v.file)).toEqual(["a.safetensors"]);
    release();
  });

  it("keeps who downloads into each ComfyUI, two asked in turn not asking theirs again each time", async () => {
    const d = open();
    const [one, two] = [stub(1), stub(2)];
    for (let i = 0; i < 3; i++) {
      await d.route(one, "");
      await d.route(two, "");
    }
    expect(folderAsks).toBe(2);
  });

  it("says a file stopped once it was whole and named done, not stopped with nothing kept", async () => {
    const d = open();
    let id = "";
    fetched.run = async (o) => {
      // the file in its place, and the stop comes just then
      writeFileSync(o.dest, "x");
      await until(() => id !== "");
      expect(d.stop(id)).toBe(true);
    };
    const started = d.start(stub(), "http://127.0.0.1:2", want);
    id = (await started).id;
    listed = ["a.safetensors"];
    await until(() => d.get(id)?.status === "done");
    expect(readFileSync(join(loras, "a.safetensors"), "utf8")).toBe("x");
  });

  it("keeps the ones not asked again yet in the state file while the first ones are asked again after a restart", async () => {
    const file = join(dir, "downloads.json");
    const queued = (id: string, order: number) => ({ id, file: `${id}.safetensors`, folder: "loras", title: id, bytes: 0, total: 0, status: "starting", queued: true, order, ask: { file: `${id}.safetensors` }, from: "http://127.0.0.1:2" });
    writeFileSync(file, JSON.stringify([queued("a", 1), queued("b", 2), queued("c", 3), { id: "z", file: "z.safetensors", folder: "loras", title: "z", bytes: 1, total: 1, status: "done", finishedAt: Date.now() }]));
    const d = open(file);
    await d.restored;
    let release = () => {};
    const asked: string[] = [];
    const resumed = d.resume(async (ask) => {
      asked.push((ask as { file: string }).file);
      if (asked.length === 1) await new Promise((r) => (release = () => r(undefined)));
    });
    await until(() => asked.length === 1);
    // the list changes while the first is asked again (a finished one taken off): the state file is written then
    d.stop("z");
    await d.flushed();
    expect((JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string }>).map((k) => k.id).sort()).toEqual(["a", "b", "c"]);
    release();
    await resumed;
    expect(asked).toEqual(["a.safetensors", "b.safetensors", "c.safetensors"]);
  });
  it("lets a download stopped a moment ago let go of its .part before the same file starts again (card #236)", async () => {
    const d = open();
    const comfy = stub();
    let letGo = () => {};
    let aGone = false;
    // the first: stopped while its hash follower still reads, which then removes its .part by name
    fetched.run = async (o) => {
      writeFileSync(`${o.dest}.part`, "first");
      await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise<void>((resolve) => (letGo = resolve));
      rmSync(`${o.dest}.part`, { force: true });
      aGone = true;
      throw new Error("stopped");
    };
    const a = await d.start(comfy, "http://127.0.0.1:2", want);
    await until(() => existsSync(join(loras, "a.safetensors.part")));
    expect(d.stop(a.id)).toBe(true);
    // the second writes its own .part and names it once the first is gone
    fetched.run = async (o) => {
      writeFileSync(`${o.dest}.part`, "second");
      await until(() => aGone);
      renameSync(`${o.dest}.part`, o.dest);
    };
    const b = d.start(comfy, "http://127.0.0.1:2", want);
    await new Promise((r) => setTimeout(r, 100));
    letGo();
    const id = (await b).id;
    listed = ["a.safetensors"];
    await until(() => d.get(id)?.status !== "downloading" && d.get(id)?.status !== "starting");
    expect(d.get(id)).toMatchObject({ status: expect.stringMatching(/^(saving|done)$/) });
    expect(readFileSync(join(loras, "a.safetensors"), "utf8")).toBe("second");
  });

  it("starts the same file into a models folder two ComfyUIs share once, whichever asked (card #236)", async () => {
    let release = () => {};
    fetched.run = () => new Promise((r) => (release = () => r(undefined)));
    const d = open();
    const a = await d.start(stub(1), "http://127.0.0.1:2", want);
    const b = await d.start(stub(3), "http://127.0.0.1:2", want);
    expect(b.id).toBe(a.id);
    expect(d.list()).toHaveLength(1);
    release();
  });

  it("carries a Download again on from what the failed one left, of the same source only (card #256)", async () => {
    const d = open();
    const comfy = stub();
    const asked: Fetched[] = [];
    fetched.run = async (o) => {
      asked.push(o);
      writeFileSync(`${o.dest}.part`, "half");
      throw new Passing("The download failed 5 times in a row (the connection was cut at 1 MB). Press Download again to carry on from 1 MB.");
    };
    const first = await d.start(comfy, "http://127.0.0.1:2", want);
    await until(() => d.get(first.id)?.status === "error");
    expect(asked[0]).toMatchObject({ keepPart: true, takeOver: false });
    const again = await d.start(comfy, "http://127.0.0.1:2", want);
    await until(() => d.get(again.id)?.status === "error");
    expect(asked[1]).toMatchObject({ takeOver: true });
    // the first taken off the list now: what the second left stays for a third
    expect(d.stop(first.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(loras, "a.safetensors.part"))).toBe(true);
    // another source for the same name: never its bytes
    await d.start(comfy, "http://127.0.0.1:2", { ...want, source: "http://127.0.0.1:1/other.safetensors" });
    await until(() => asked.length === 3);
    expect(asked[2]).toMatchObject({ takeOver: false });
  });

  it("tells a download how much the other one under way on the same disk still has to write (card #256)", async () => {
    const d = open();
    const comfy = stub();
    let release = () => {};
    const kept: number[] = [];
    fetched.run = async (o) => {
      if (o.dest.endsWith("a.safetensors")) return new Promise((r) => (release = () => r(undefined)));
      kept.push(o.reserved!());
    };
    await d.start(comfy, "http://127.0.0.1:2", { ...want, total: 5000 });
    await d.start(comfy, "http://127.0.0.1:2", { ...want, file: "b.safetensors", total: 100 });
    await until(() => kept.length === 1);
    expect(kept).toEqual([5000]);
    release();
  });
});
