import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comfy } from "../src/comfy";
import { Downloads } from "../src/downloads";
import { until } from "./helpers";

/** The ids the state file holds now (it is written whole, through a file beside it, so it always reads). */
const idsIn = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string }>).map((d) => d.id).join(",");

/** The downloads' state file between two runs: what was under way when Afflatus stopped is said to have been interrupted. */
describe("the downloads' state file", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-downloads-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists an interrupted download as failed at the next start, keeps a finished one, drops an old one, and dismisses on stop", async () => {
    const file = join(dir, "downloads.json");
    const now = Date.now();
    writeFileSync(file, JSON.stringify([
      { id: "a", file: "big.safetensors", folder: "checkpoints", title: "Big", bytes: 1000, total: 5000, status: "downloading" },
      { id: "b", file: "done.safetensors", folder: "vae", title: "Done", bytes: 10, total: 10, status: "done", finishedAt: now - 60_000 },
      { id: "c", file: "old.safetensors", folder: "vae", title: "Old", bytes: 10, total: 10, status: "done", finishedAt: now - 3 * 60 * 60_000 },
    ]));
    const events = new EventEmitter();
    let told = 0;
    events.on("downloads", () => told++);
    const downloads = new Downloads(events, file);
    await downloads.restored;
    const list = downloads.list();
    expect(list.map((d) => [d.id, d.status])).toEqual([["b", "done"], ["a", "error"]]);
    expect(list.find((d) => d.id === "a")!.error).toMatch(/Interrupted: Afflatus was stopped or restarted/);
    // an interruption is news: told once read
    expect(told).toBe(1);
    // dismissed, and the file follows
    expect(downloads.stop("a")).toBe(true);
    expect(downloads.list().map((d) => d.id)).toEqual(["b"]);
    // written a moment later: the list without it
    await until(() => idsIn(file) === "b");
    expect(downloads.stop("nothing")).toBe(false);
  });

  it("keeps a failure marked read across a restart, so a page opened later does not announce it again", async () => {
    const file = join(dir, "downloads.json");
    writeFileSync(file, JSON.stringify([
      { id: "f", file: "failed.safetensors", folder: "diffusion_models", title: "Failed", bytes: 10, total: 50, status: "error", error: "cut", finishedAt: Date.now() - 60_000 },
    ]));
    const first = new Downloads(new EventEmitter(), file);
    await first.restored;
    expect(first.list()[0]!.seen).toBeUndefined();
    expect(first.seen("f")).toBe(true);
    expect(first.seen("nothing")).toBe(false);
    // still listed (Settings shows it), read
    expect(first.list()).toMatchObject([{ id: "f", status: "error", seen: true }]);
    await until(() => (JSON.parse(readFileSync(file, "utf8")) as Array<{ seen?: boolean }>)[0]?.seen === true);
    // the next start reads it back as read
    const again = new Downloads(new EventEmitter(), file);
    await again.restored;
    expect(again.list()).toMatchObject([{ id: "f", status: "error", seen: true }]);
  });

  it("lists one ComfyUI-Manager was saving as done, and writes the file whole, through a file beside it", async () => {
    const file = join(dir, "downloads.json");
    writeFileSync(file, JSON.stringify([{ id: "s", file: "sent.safetensors", folder: "loras", title: "Sent", bytes: 10, total: 10, status: "saving" }]));
    const downloads = new Downloads(new EventEmitter(), file);
    await downloads.restored;
    expect(downloads.list()).toMatchObject([{ id: "s", status: "done" }]);
    expect(downloads.list()[0]!.error).toBeUndefined();
    expect(downloads.stop("s")).toBe(true);
    await until(() => idsIn(file) === "");
    expect(readdirSync(dir)).toEqual(["downloads.json"]);
  });

  it("removes the .part of a download Afflatus was writing itself when it stopped", async () => {
    const file = join(dir, "downloads.json");
    const part = join(dir, "big.safetensors.part");
    writeFileSync(part, "half");
    writeFileSync(file, JSON.stringify([{ id: "h", file: "big.safetensors", folder: "loras", title: "Big", bytes: 4, total: 8, status: "downloading", via: "afflatus", part }]));
    const downloads = new Downloads(new EventEmitter(), file);
    await downloads.restored;
    expect(downloads.list()).toMatchObject([{ id: "h", status: "error", via: "afflatus" }]);
    // the path of the .part stays in the state file, never in what the browser is told
    expect(downloads.list()[0]).not.toHaveProperty("part");
    await until(() => readdirSync(dir).join() === "downloads.json");
  });

  it("keeps a failure nobody read for a day, where a read one or a finished one goes after an hour", async () => {
    const file = join(dir, "downloads.json");
    const now = Date.now();
    const hours = (n: number) => now - n * 60 * 60_000;
    writeFileSync(file, JSON.stringify([
      { id: "unread", file: "a.safetensors", folder: "loras", title: "A", bytes: 0, total: 0, status: "error", error: "cut", finishedAt: hours(3) },
      { id: "read", file: "b.safetensors", folder: "loras", title: "B", bytes: 0, total: 0, status: "error", error: "cut", seen: true, finishedAt: hours(3) },
      { id: "done", file: "c.safetensors", folder: "loras", title: "C", bytes: 1, total: 1, status: "done", finishedAt: hours(3) },
      { id: "too-old", file: "d.safetensors", folder: "loras", title: "D", bytes: 0, total: 0, status: "error", error: "cut", finishedAt: hours(25) },
    ]));
    const downloads = new Downloads(new EventEmitter(), file);
    await downloads.restored;
    expect(downloads.list().map((d) => d.id)).toEqual(["unread"]);
    // read now: an hour after it ended, it goes
    downloads.seen("unread");
    expect(downloads.list()).toEqual([]);
  });

  it("is nothing without a state file, and does not mind one it cannot read", async () => {
    const bare = new Downloads(new EventEmitter());
    await bare.restored;
    expect(bare.list()).toEqual([]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    const d = new Downloads(new EventEmitter(), broken);
    await d.restored;
    expect(d.list()).toEqual([]);
  });
});

/** A node pack that answers, but says nothing usable: the download is given up, never left "downloading". */
describe("the node pack's answers", () => {
  let comfy: Server;
  let polled = 0;
  const was = process.env.CIVITAI_URL;
  beforeEach(async () => {
    polled = 0;
    comfy = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/afflatus/download") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "p1", path: "/models/loras/a.safetensors" }));
      }
      if (req.method === "GET" && req.url === "/afflatus/download/p1") {
        polled++;
        // a ComfyUI in trouble: its error page, then a body that is not the state
        if (polled % 2) {
          res.writeHead(500, { "content-type": "text/html" });
          return res.end("<html>500</html>");
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{not json");
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => comfy.listen(0, "127.0.0.1", r));
    process.env.CIVITAI_URL = "http://127.0.0.1:1";
  });
  afterEach(async () => {
    if (was === undefined) delete process.env.CIVITAI_URL;
    else process.env.CIVITAI_URL = was;
    await new Promise((r) => comfy.close(r));
  });

  it("counts a 5xx and a body that is not the state as silence, and gives the download up after a while of it", async () => {
    const baseUrl = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`;
    // a ComfyUI on another machine with a pack that downloads: no folder of its is written from here
    const stub = { url: "http://192.0.2.10:8188", client: { baseUrl, packVersion: async () => "0.11.1", models: async () => [] }, forgetAll() {} } as unknown as Comfy;
    const downloads = new Downloads(new EventEmitter());
    downloads.packEveryMs = 5;
    downloads.packSilentMs = 100;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = await downloads.start(stub, "http://127.0.0.1:2", { file: "a.safetensors", folder: "loras", title: "A", source: "http://127.0.0.1:1/a.safetensors" });
      expect(d.via).toBe("pack");
      await until(() => downloads.list()[0]!.status === "error");
      expect(downloads.list()[0]!.error).toMatch(/node pack says nothing usable about the download \(HTTP 500\)/);
      expect(polled).toBeGreaterThan(2);
    } finally {
      warn.mockRestore();
    }
  });
});
