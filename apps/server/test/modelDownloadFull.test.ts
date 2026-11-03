import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A disk that fills up under a download: every write to a file named "full…" fails with ENOSPC, as Windows and Linux say
 * it. Everything else is the real file system.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    if (!/full[^\\/]*$/.test(String(args[0])) || args[1] === "r") return handle;
    const full = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
    };
    return new Proxy(handle, {
      get: (target, key) => {
        if (key === "write") return full;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});
const { fetchToFile, Refused, Slots } = await import("../src/modelDownload");

/** A file of 2 MB, served whole or in parts. */
const SIZE = 2 * 2 ** 20;
const FILE = Buffer.alloc(SIZE, 7);

describe("a disk that fills up under a download (card #256)", () => {
  let site: Server;
  let url = "";
  let dir = "";
  let asked = 0;
  beforeEach(async () => {
    asked = 0;
    dir = mkdtempSync(join(tmpdir(), "afflatus-full-"));
    site = createServer((req, res) => {
      asked++;
      const got = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = got ? Number(got[1]) : 0;
      const end = got?.[2] ? Number(got[2]) : SIZE - 1;
      res.writeHead(got ? 206 : 200, { "content-type": "application/octet-stream", "content-length": end - start + 1, ...(got ? { "content-range": `bytes ${start}-${end}/${SIZE}` } : {}) });
      res.end(FILE.subarray(start, end + 1));
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/full.bin`;
  });
  afterEach(async () => {
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchTo = (parts?: boolean) => {
    const notes: string[] = [];
    const done = fetchToFile({
      source: url, headers: {}, allow: [url], dest: join(dir, "full.bin"), signal: new AbortController().signal, onBytes: () => {},
      onRetry: (n) => notes.push(n), backoffMs: 5, free: async () => 100 * 2 ** 30, keepPart: true,
      ...(parts ? { parts: { connections: 4, from: 2 ** 20, piece: 256 * 2 ** 10, slots: new Slots(4) } } : {}),
    });
    return { done, notes };
  };

  it.each([["over one connection", false], ["in parts", true]])("says a full disk at once %s, never as a cut tried five times", async (_, parts) => {
    const { done, notes } = fetchTo(parts);
    await expect(done).rejects.toThrow("The disk is full (ENOSPC): make room, then press Download again.");
    await expect(done).rejects.toBeInstanceOf(Refused);
    expect(notes).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    // one request over one connection, the byte asked first and the pieces under way in parts: never asked again
    expect(asked).toBeLessThanOrEqual(parts ? 5 : 1);
  });
});
