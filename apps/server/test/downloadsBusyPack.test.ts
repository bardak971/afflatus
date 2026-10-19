import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comfy } from "../src/comfy";
import { Downloads, PASSING } from "../src/downloads";
import { until } from "./helpers";

/**
 * A node pack whose line is full (429: its two downloads at once under way), and one that forgot a download: a pod getting
 * its files once gave a red "Download of … failed" banner for each, though every file came (the queue asked again).
 */
describe("a node pack that is busy, or forgot a download", () => {
  let comfy: Server;
  let busy = 0;
  let asked = 0;
  let lost = false;
  const was = process.env.CIVITAI_URL;
  beforeEach(async () => {
    busy = 0;
    asked = 0;
    lost = false;
    comfy = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/afflatus/download") {
        asked++;
        if (busy > 0) {
          busy--;
          res.writeHead(429, { "content-type": "text/plain" });
          return res.end("2 downloads are under way already");
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "p1", path: "/models/loras/a.safetensors" }));
      }
      if (req.method === "GET" && req.url === "/afflatus/download/p1") {
        // a pack restarted under it knows it no more; else it is done at once
        if (lost) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ state: "done", bytes: 10 }));
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

  const stub = () => {
    const baseUrl = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`;
    // a ComfyUI on another machine (a pod) with a pack that downloads
    return { url: "http://192.0.2.10:8188", client: { baseUrl, raw: (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init), packVersion: async () => "0.11.1", models: async () => [] }, forgetAll() {} } as unknown as Comfy;
  };
  const make = () => {
    const downloads = new Downloads(new EventEmitter());
    downloads.packEveryMs = 5;
    downloads.packBusyEveryMs = 5;
    return downloads;
  };
  const want = { file: "a.safetensors", folder: "loras", title: "A", source: "http://127.0.0.1:1/a.safetensors", machine: "rp-1" };

  it("waits for a busy pack's line as a download waiting its turn, never a failure", async () => {
    busy = 3;
    const downloads = make();
    const statuses = new Set<string>();
    const d = await downloads.start(stub(), "http://127.0.0.1:2", want);
    await until(() => {
      const now = downloads.get(d.id)!;
      statuses.add(now.status);
      return now.status === "saving" || now.status === "done";
    });
    expect(asked).toBe(4);
    expect(statuses.has("error")).toBe(false);
    expect(downloads.list().some((x) => x.status === "error")).toBe(false);
  });

  it("gives a pack that stays busy up, as a failure that passes (the pod's files ask again)", async () => {
    busy = 1_000;
    const downloads = make();
    downloads.packBusyMs = 50;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = await downloads.start(stub(), "http://127.0.0.1:2", want);
      await until(() => downloads.get(d.id)!.status === "error");
      expect(downloads.get(d.id)!.error).toMatch(/\(429: /);
      expect(PASSING.test(downloads.get(d.id)!.error!)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a failure that passes off the page's list while the pod's files will ask again (quietPassing), and says it otherwise", async () => {
    lost = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const quiet = make();
      const a = await quiet.start(stub(), "http://127.0.0.1:2", { ...want, quietPassing: true });
      await until(() => quiet.get(a.id)!.status === "error");
      expect(quiet.get(a.id)!.error).toMatch(/no longer knows the download/);
      expect(quiet.list().find((x) => x.id === a.id)).toBeUndefined();

      // asked by hand (no quietPassing), or the pod's files' last try: said, as before
      const said = make();
      const b = await said.start(stub(), "http://127.0.0.1:2", want);
      await until(() => said.get(b.id)!.status === "error");
      expect(said.list().find((x) => x.id === b.id)).toMatchObject({ status: "error" });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
