import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comfy } from "../src/comfy";
import { Downloads } from "../src/downloads";
import { until } from "./helpers";

/**
 * The downloads' line (card #60): two at a time per ComfyUI, each its place in the line, a waiting one moved, the line kept
 * across a restart and asked again in its order. A node pack stands in for the ComfyUI: its downloads never end.
 */
describe("the downloads' line", () => {
  let comfy: Server;
  let dir = "";
  let posted: Array<{ filename: string; dir?: string }>;
  let packVersion = "0.36.9";
  const was = process.env.CIVITAI_URL;
  let made: Downloads[] = [];
  let stub: Comfy;
  beforeEach(async () => {
    posted = [];
    packVersion = "0.36.9";
    dir = mkdtempSync(join(tmpdir(), "afflatus-line-"));
    comfy = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/afflatus/download") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const b = JSON.parse(body) as { filename: string; dir?: string };
          posted.push(b);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `p-${b.filename}`, path: `/workspace/ComfyUI/models/loras/${b.filename}`, root: "/workspace/ComfyUI/models/loras" }));
        });
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/afflatus/download/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ state: "downloading", bytes: 10 }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => comfy.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`;
    // a ComfyUI on another machine (a pod) whose node pack downloads, and says its folders: its own one is /workspace/ComfyUI
    const folderPaths = { custom_nodes: ["/workspace/ComfyUI/custom_nodes"], loras: ["/workspace/extra/loras", "/workspace/ComfyUI/models/loras"] };
    stub = {
      url: "http://192.0.2.10:8188",
      client: {
        baseUrl,
        raw: (path: string, init?: RequestInit) => (path === "/internal/folder_paths" ? Promise.resolve(new Response(JSON.stringify(folderPaths))) : fetch(`${baseUrl}${path}`, init)),
        packVersion: async () => packVersion,
        models: async () => [],
      },
      forgetAll() {},
    } as unknown as Comfy;
    process.env.CIVITAI_URL = "http://127.0.0.1:1";
  });
  afterEach(async () => {
    for (const d of made) {
      for (const v of d.list()) d.stop(v.id);
      await d.flushed();
    }
    made = [];
    if (was === undefined) delete process.env.CIVITAI_URL;
    else process.env.CIVITAI_URL = was;
    await new Promise((r) => comfy.close(r));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const open = (file?: string) => {
    const d = new Downloads(new EventEmitter(), file);
    d.packEveryMs = 20;
    d.signer = async () => null;
    made.push(d);
    return d;
  };
  const ask = (d: Downloads, n: string, more: { place?: string } = {}) =>
    d.start(stub, "http://127.0.0.1:2", { file: `${n}.safetensors`, folder: "loras", title: n, source: `http://127.0.0.1:1/${n}.safetensors`, ask: { file: `${n}.safetensors`, folder: "loras", url: `https://x.test/${n}` }, ...more });
  const turns = (d: Downloads) => Object.fromEntries(d.list().map((v) => [v.file.replace(".safetensors", ""), v.turn]));

  it("gives each its place, moves a waiting one, and keeps the line across a restart, asked again in its order", async () => {
    const file = join(dir, "downloads.json");
    const first = open(file);
    for (const n of ["a", "b", "c", "d", "e"]) await ask(first, n);
    await until(() => posted.length === 2);
    expect(turns(first)).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(first.list().find((v) => v.file === "c.safetensors")!.waiting).toBe("behind a.safetensors and b.safetensors");
    // the pack says where it lands: the folder, short under ComfyUI's own
    await until(() => first.list().find((v) => v.file === "a.safetensors")!.shown === "models/loras");
    const id = (n: string) => first.list().find((v) => v.file === `${n}.safetensors`)!.id;
    // e dragged before c; then c to the end
    expect(first.move(id("e"), id("c"))).toBe(true);
    expect(turns(first)).toEqual({ a: 1, b: 2, e: 3, c: 4, d: 5 });
    expect(first.move(id("c"), null)).toBe(true);
    expect(turns(first)).toEqual({ a: 1, b: 2, e: 3, d: 4, c: 5 });
    // one under way does not move, nor before one under way
    expect(first.move(id("a"), null)).toBe(false);
    expect(first.move(id("d"), id("a"))).toBe(false);
    await first.flushed();

    // Afflatus restarts: the waiting ones are asked again in their order; those under way are said interrupted, with a Try again
    const again = open(file);
    await again.restored;
    const order: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await again.resume(async (asked) => {
        order.push((asked as { file: string }).file);
        return ask(again, (asked as { file: string }).file.replace(".safetensors", ""));
      });
    } finally {
      warn.mockRestore();
    }
    expect(order).toEqual(["e.safetensors", "d.safetensors", "c.safetensors"]);
    const now = again.list();
    expect(now.filter((v) => v.status === "error").map((v) => [v.file, v.again])).toEqual(expect.arrayContaining([["a.safetensors", true], ["b.safetensors", true]]));
    expect(again.askOf(now.find((v) => v.file === "a.safetensors")!.id)).toMatchObject({ ask: { url: "https://x.test/a" }, from: "http://127.0.0.1:2" });
    // the ones asked again run in the order they were left in
    await until(() => posted.length === 4);
    expect(posted.slice(2).map((p) => p.filename)).toEqual(["e.safetensors", "d.safetensors"]);
  });

  it("takes every waiting one out of the line at once, and clears the finished ones", async () => {
    const d = open();
    for (const n of ["a", "b", "c", "d"]) await ask(d, n);
    expect(d.cancelWaiting()).toBe(2);
    expect(d.list().filter((v) => v.status === "starting" && v.waiting)).toEqual([]);
    expect(d.list().filter((v) => v.status === "stopped").map((v) => v.file).sort()).toEqual(["c.safetensors", "d.safetensors"]);
    expect(d.clearDone()).toBe(2);
    expect(d.list().map((v) => v.file).sort()).toEqual(["a.safetensors", "b.safetensors"]);
  });

  it("asks the node pack for the place chosen, only one that takes it", async () => {
    const d = open();
    await ask(d, "a", { place: "/workspace/extra/loras" });
    packVersion = "0.36.8";
    await ask(d, "b", { place: "/workspace/extra/loras" });
    await until(() => posted.length === 2);
    expect(posted.map((p) => p.dir)).toEqual(["/workspace/extra/loras", undefined]);
  });
});
