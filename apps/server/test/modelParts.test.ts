import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchToFile, Refused, Slots, type FetchTo } from "../src/modelDownload";
import { until } from "./helpers";

/**
 * Afflatus's own downloads over several connections (card #205): a pretend Civitai that asks for the key and sends each
 * request on to a signed link on its file server, which serves parts of the file. A file of 4.5 MB in pieces of 512 KB,
 * fetched in parts from 1 MB on, stands for 20 GB in pieces of 256 MB.
 */
const SIZE = 4.5 * 2 ** 20;
const FILE = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) FILE[i] = (i * 31 + (i >> 12)) & 255;
FILE.writeBigUInt64LE(2n, 0);
FILE.write("{}", 8);
const SHA = createHash("sha256").update(FILE).digest("hex");
const PIECE = 512 * 2 ** 10;
const PARTS = { connections: 4, from: 2 ** 20, piece: PIECE };

/** Every request either server had: which, its path, the link's signature, its Range and the key it carried. */
let asked: Array<{ host: "site" | "store"; path: string; sig?: number; range?: string; auth?: string }>;
let site: Server;
let store: Server;
let siteUrl: string;
let storeUrl: string;
let dir: string;
/** How the file server behaves: see the handler. */
let mode: {
  /** A part from this byte on is answered so, a moment late: the whole file (200) or "too many requests" (429). */
  refuse?: { status: 200 | 429; from: number };
  /** The first part asked for from this byte on is cut a little way in. */
  cutFrom?: number;
  /** Each part comes this many bytes in, then nothing more: a download to stop. */
  stall?: number;
  /** The link of the first signature is refused (expired) after this many requests to it. */
  expireAfter?: number;
  /** Open-ended requests (one connection's) are cut once after this many bytes. */
  cutWhole?: number;
  /** Parts from this byte on are answered 503, a moment late. */
  failFrom?: number;
  /** No part is answered longer than this (a file server that caps its ranges). */
  cap?: number;
  /** The first part asked comes a little way in, then nothing more, never closed. */
  stallOnce?: boolean;
  /** The size the site says on its redirect (Hugging Face's x-linked-size). */
  linkedSize?: number;
};
let open: number;
let most: number;

const piecesAsked = () => asked.filter((a) => a.host === "store" && /^bytes=\d+-\d+$/.test(a.range ?? "") && a.range !== "bytes=0-0");

beforeEach(async () => {
  asked = [];
  mode = {};
  open = 0;
  most = 0;
  dir = mkdtempSync(join(tmpdir(), "afflatus-parts-"));
  let signed = 0;
  let cut = false;
  let stalled = false;
  site = createServer((req, res) => {
    const path = req.url ?? "";
    asked.push({ host: "site", path, range: req.headers.range, auth: req.headers.authorization });
    if (path !== "/api/download/models/1") return void res.writeHead(404).end();
    if (req.headers.authorization !== "Bearer k-123456789") {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Unauthorized", message: "The creator of this asset requires you to be logged in to download it" }));
    }
    // a fresh signed link each time it is asked
    res.writeHead(307, { location: `${storeUrl}/file?sig=${++signed}`, ...(mode.linkedSize ? { "x-linked-size": String(mode.linkedSize) } : {}) });
    res.end();
  });
  store = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "", "http://x");
    const sig = Number(url.searchParams.get("sig"));
    const range = req.headers.range;
    asked.push({ host: "store", path: url.pathname, sig, range, auth: req.headers.authorization });
    open++;
    most = Math.max(most, open);
    res.on("close", () => open--);
    if (mode.expireAfter !== undefined && sig === 1 && asked.filter((a) => a.host === "store" && a.sig === 1).length > mode.expireAfter) return void res.writeHead(403).end();
    const got = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    const closed = Boolean(got?.[2]) && range !== "bytes=0-0";
    if (closed && mode.refuse && Number(got![1]) >= mode.refuse.from) {
      const { status } = mode.refuse;
      return void setTimeout(() => (status === 429 ? res.writeHead(429).end() : res.writeHead(200, { "content-type": "application/octet-stream", "content-length": SIZE }).end(FILE)), 150);
    }
    if (closed && mode.failFrom !== undefined && Number(got![1]) >= mode.failFrom) return void setTimeout(() => res.writeHead(503).end(), 200);
    const start = got ? Number(got[1]) : 0;
    const end = got?.[2] ? Math.min(Number(got[2]), closed && mode.cap ? start + mode.cap - 1 : Infinity) : SIZE - 1;
    const body = FILE.subarray(start, end + 1);
    res.writeHead(got ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(got ? { "content-range": `bytes ${start}-${end}/${SIZE}` } : {}) });
    if (mode.stall !== undefined && closed) return void res.write(body.subarray(0, mode.stall));
    if (mode.stallOnce && closed && !stalled) {
      stalled = true;
      return void res.write(body.subarray(0, 1000));
    }
    const cutAt = closed && mode.cutFrom !== undefined && start >= mode.cutFrom && !cut ? 100_000 : !closed && got?.[1] !== "0" && mode.cutWhole !== undefined && !cut ? mode.cutWhole : null;
    if (cutAt !== null && range !== "bytes=0-0") {
      cut = true;
      // the bytes written reach the other end before the connection is cut
      return void res.write(body.subarray(0, cutAt), () => setTimeout(() => res.socket?.destroy(), 100));
    }
    // a part a moment late, as from far away: the connections overlap
    setTimeout(() => res.end(body), closed ? 20 : 0);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => store.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
});
afterEach(async () => {
  site.closeAllConnections();
  store.closeAllConnections();
  await new Promise((r) => site.close(r));
  await new Promise((r) => store.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const fetchTo = (over: Partial<FetchTo> = {}, name = "model.safetensors") => {
  const notes: string[] = [];
  const counts: number[] = [];
  const dest = join(dir, name);
  const done = fetchToFile({
    source: `${siteUrl}/api/download/models/1`, headers: { Authorization: "Bearer k-123456789" }, allow: [siteUrl, storeUrl], dest,
    signal: new AbortController().signal, onBytes: (b) => counts.push(b), onRetry: (n) => notes.push(n), backoffMs: 5,
    free: async () => 100 * 2 ** 30, parts: { ...PARTS, slots: new Slots(8) }, ...over,
  });
  return { done, notes, counts, dest };
};

describe("Afflatus's own downloads over several connections (card #205)", () => {
  it("fetches a big file in pieces over several connections at once, byte for byte, the key to the site alone", async () => {
    const { done, counts, dest } = fetchTo();
    await expect(done).resolves.toEqual({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    expect(readdirSync(dir)).toEqual(["model.safetensors"]);
    // one byte asked at the site with the key, then every piece from the signed link, never with the key
    expect(asked.filter((a) => a.host === "site")).toEqual([{ host: "site", path: "/api/download/models/1", range: "bytes=0-0", auth: "Bearer k-123456789" }]);
    expect(asked.filter((a) => a.host === "store" && a.auth)).toEqual([]);
    expect(piecesAsked().map((a) => a.range).sort()).toEqual(Array.from({ length: 9 }, (_, i) => `bytes=${i * PIECE}-${(i + 1) * PIECE - 1}`).sort());
    // several at once, never more than asked
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    expect(counts.at(-1)).toBe(SIZE);
  });

  it("asks a small file no byte first when its size is known, and fetches it over one connection", async () => {
    await expect(fetchTo({ size: SIZE, parts: { ...PARTS, from: SIZE + 1, slots: new Slots(8) } }).done).resolves.toMatchObject({ bytes: SIZE });
    expect(asked.map((a) => a.range)).toEqual([undefined, undefined]);
  });

  it("picks a cut piece up from the byte it had, not from the piece's start", async () => {
    mode.cutFrom = 2 * PIECE;
    const { done, notes, dest } = fetchTo();
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    // asked again from inside the piece
    expect(piecesAsked().some((a) => Number(/^bytes=(\d+)-/.exec(a.range!)![1]) % PIECE !== 0)).toBe(true);
    expect(notes).toEqual([expect.stringMatching(/^The connection was cut: trying that part again \(2 of 5\)\.$/)]);
  });

  it.each([[200, "the site sent the whole file to a request for part of it"], [429, "the site answered 429 to several connections at once"]] as const)(
    "carries on over one connection from the bytes whole from the first on, when a part is answered %i",
    async (status, why) => {
      mode.refuse = { status, from: 2 * PIECE };
      const { done, notes, dest } = fetchTo();
      await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
      expect(readFileSync(dest).equals(FILE)).toBe(true);
      expect(notes).toEqual([expect.stringMatching(new RegExp(`^${why[0]!.toUpperCase()}${why.slice(1)}: the rest over one connection, from \\d+ MB\\.$`))]);
      // one connection, from the site again (with the key) and on to the file server with its Range, from a byte past the first
      const last = asked.at(-1)!;
      expect(last).toMatchObject({ host: "store", range: expect.stringMatching(/^bytes=\d+-$/) });
      expect(Number(/\d+/.exec(last.range!)![0])).toBeGreaterThanOrEqual(2 * PIECE);
      expect(last.auth).toBeUndefined();
      expect(asked.at(-2)).toMatchObject({ host: "site", auth: "Bearer k-123456789", range: last.range });
    },
  );

  it("asks the site again for a link that expired, one connection for all, and the key still goes to the site alone", async () => {
    mode.expireAfter = 4;
    const { done, dest } = fetchTo();
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    // asked twice at the site, each time one byte: the first link and its renewal
    expect(asked.filter((a) => a.host === "site").map((a) => [a.range, a.auth])).toEqual([["bytes=0-0", "Bearer k-123456789"], ["bytes=0-0", "Bearer k-123456789"]]);
    expect(piecesAsked().filter((a) => a.sig === 2).length).toBeGreaterThan(0);
    expect(asked.filter((a) => a.host === "store" && a.auth)).toEqual([]);
  });

  it("checks the file against the SHA-256 its source lists, and keeps nothing of one that does not match", async () => {
    await expect(fetchTo({ sha256: SHA.toUpperCase() }).done).resolves.toMatchObject({ sha256: SHA });
    rmSync(join(dir, "model.safetensors"));
    const wrong = fetchTo({ sha256: "0".repeat(64) }).done;
    await expect(wrong).rejects.toThrow("The file came damaged: its SHA-256 is not the one the site lists. Press Download again.");
    await expect(wrong).rejects.toBeInstanceOf(Refused);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a file the disk has no room for once the site says its size, before a part is asked", async () => {
    await expect(fetchTo({ free: async () => 2 ** 20 }).done).rejects.toThrow(/Not enough free space for it: the file is 5 MB/);
    expect(piecesAsked()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops every connection at a stop, and leaves nothing", async () => {
    mode.stall = 64 * 2 ** 10;
    const stop = new AbortController();
    const { done } = fetchTo({ signal: stop.signal });
    await until(() => piecesAsked().length === 4 && open === 4);
    stop.abort();
    await expect(done).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
    await until(() => open === 0);
  });

  it("shares its connections with the other downloads: two files at once never use more than there are", async () => {
    const slots = new Slots(3);
    const a = fetchTo({ parts: { ...PARTS, slots } }, "a.safetensors");
    const b = fetchTo({ parts: { ...PARTS, slots } }, "b.safetensors");
    await expect(Promise.all([a.done, b.done])).resolves.toEqual([{ bytes: SIZE, sha256: SHA }, { bytes: SIZE, sha256: SHA }]);
    expect(most).toBeLessThanOrEqual(3);
    expect(readFileSync(a.dest).equals(FILE) && readFileSync(b.dest).equals(FILE)).toBe(true);
  });

  it("carries its Range on to the file server after a cut over one connection, instead of starting over", async () => {
    mode.cutWhole = 300_000;
    // the first request asks no Range: cut it as it comes
    mode.cutFrom = undefined;
    const { done, notes, dest } = fetchTo({ parts: undefined });
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    expect(notes.join(" ")).not.toMatch(/starting over/);
    expect(asked.filter((a) => a.host === "store").map((a) => a.range)).toEqual([undefined, expect.stringMatching(/^bytes=[1-9]\d*-$/)]);
  });
  it("carries on in parts from what an earlier try left, its bytes counted in the SHA-256 (card #256)", async () => {
    const kept = 2 * PIECE + 1000;
    writeFileSync(join(dir, "model.safetensors.part"), FILE.subarray(0, kept));
    const { done, dest, counts } = fetchTo({ takeOver: true, sha256: SHA });
    await expect(done).resolves.toEqual({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    // never a byte before what it had
    expect(Math.min(...piecesAsked().map((a) => Number(/\d+/.exec(a.range!)![0])))).toBe(kept);
    expect(counts[0]).toBe(kept);
  });

  it("keeps the bytes whole from the first on when the parts keep failing, for the next try to carry on from (card #256)", async () => {
    mode.failFrom = 2 * PIECE;
    const { done, dest } = fetchTo({ attempts: 2, keepPart: true });
    await expect(done).rejects.toThrow(/^The download failed 2 times in a row \(the site answered 503\)\. Press Download again to carry on from where it stopped\.$/);
    expect(readFileSync(`${dest}.part`).equals(FILE.subarray(0, 2 * PIECE))).toBe(true);
  });

  it("takes a part answered shorter than asked as far as it goes, and asks for the rest of it (card #236)", async () => {
    mode.cap = 100_000;
    const { done, dest } = fetchTo();
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    expect(piecesAsked().some((a) => Number(/^bytes=(\d+)-/.exec(a.range!)![1]) % PIECE === 100_000)).toBe(true);
  });

  it("refuses a size Hugging Face says otherwise before a part is asked, not once all of it came (card #236)", async () => {
    mode.linkedSize = SIZE + 1;
    await expect(fetchTo().done).rejects.toThrow(`The site says the file is ${SIZE + 1} bytes, and sends ${SIZE}.`);
    expect(piecesAsked()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a file whose size is not the one its source lists, before a part is asked (card #252)", async () => {
    await expect(fetchTo({ size: SIZE + 1 }).done).rejects.toThrow(`The site sends ${SIZE} bytes, and lists the file as ${SIZE + 1}. Press Download again.`);
    expect(piecesAsked()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes a part that stops coming for a cut, and asks for it again, instead of waiting minutes (card #256)", async () => {
    mode.stallOnce = true;
    const { done, notes, dest } = fetchTo({ stallMs: 300 });
    await expect(done).resolves.toMatchObject({ bytes: SIZE, sha256: SHA });
    expect(readFileSync(dest).equals(FILE)).toBe(true);
    expect(notes).toEqual(["Nothing came for 300 ms: trying that part again (2 of 5)."]);
  });
});
