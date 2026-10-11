import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { restoreBackup } from "../src/backup";
import { migrate, openSqlite } from "../src/db";
import { crc32 } from "../src/zip";
import { zipNames } from "./zipKit";
import { ZipStream } from "../src/zipStream";
import { get, makeApp, makeFake, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("a backup", () => {
  it("says what it would hold, and is a zip of the database and every file, made while the app runs", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=keep.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json() as { id: string };
    const plan = (await get(t.app, "/api/backup")).json();
    expect(plan).toMatchObject({ available: true, database: true });
    expect(plan.files).toBeGreaterThanOrEqual(1);
    expect(plan.bytes).toBeGreaterThan(0);

    const res = await get(t.app, "/api/backup.zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(String(res.headers["content-disposition"])).toMatch(/afflatus-backup-\d{8}-\d{4}\.zip/);
    const bytes = new Uint8Array(res.rawPayload);
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const names = zipNames(bytes);
    expect(names[0]).toBe("README.txt");
    expect(names).toContain("afflatus.db");
    expect(names.some((n) => n.startsWith("files/") && n.includes(picture.id))).toBe(true);
    // the database copy is a real SQLite file
    const at = res.rawPayload.indexOf(Buffer.from("SQLite format 3\0", "latin1"));
    expect(at).toBeGreaterThan(0);
  });

  it("stops when the browser gives up half way, and lets go of the database copy", async () => {
    // enough bytes that the first chunk is far from the end
    for (let i = 0; i < 6; i++) writeFileSync(join(t.dir, `big-${i}.bin`), Buffer.alloc(4 * 1024 * 1024, i));
    const copies = () => readdirSync(tmpdir()).filter((n) => n.startsWith("afflatus-backup-"));
    const before = copies();
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/backup.zip`, { signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    abort.abort();
    // the producer ends by itself (a write fails once the reader is gone) and the temporary copy of the database is removed
    await until(() => copies().length <= before.length, 5000);
  });
});

describe("a backup restored", () => {
  it("unpacks into an empty data folder: the database and every file come back as they were", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=keep.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json() as { id: string };
    const row = await t.db.selectFrom("assets").selectAll().where("id", "=", picture.id).executeTakeFirstOrThrow();
    const zip = join(tmpdir(), `afflatus-restore-${picture.id}.zip`);
    writeFileSync(zip, (await get(t.app, "/api/backup.zip")).rawPayload);
    const into = mkdtempSync(join(tmpdir(), "afflatus-restored-"));
    try {
      const written = await restoreBackup(zip, into);
      expect(written).toBe(zipNames(readFileSync(zip)).length);
      // the database opens, and has the library
      const db = openSqlite(join(into, "afflatus.db"));
      await migrate(db);
      expect((await db.selectFrom("assets").select(["id", "file_key"]).execute())).toEqual([{ id: picture.id, file_key: row.file_key }]);
      await db.destroy();
      // the file is where its key says, under files/, byte for byte
      expect(readFileSync(join(into, "files", row.file_key)).equals(Buffer.from(await t.services.storage.get(row.file_key)))).toBe(true);
      // a folder that holds anything already is left alone
      await expect(restoreBackup(zip, into)).rejects.toThrow(/not empty/);
    } finally {
      rmSync(into, { recursive: true, force: true });
      rmSync(zip, { force: true });
    }
  });

  it("is made all the same when a file goes while it is being made", async () => {
    // a file listed, then erased before its turn (the sweep at work): the backup goes on without it
    writeFileSync(join(t.dir, "a-first.bin"), Buffer.alloc(8 * 1024 * 1024, 1));
    writeFileSync(join(t.dir, "b-gone.bin"), Buffer.alloc(16, 2));
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/backup.zip`);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [(await reader.read()).value!];
    rmSync(join(t.dir, "b-gone.bin"));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const names = zipNames(Buffer.concat(chunks));
    expect(names).toContain("files/a-first.bin");
    expect(names).not.toContain("files/b-gone.bin");
  });
});

/** The entries of a small zip, read through its central directory: name, offset and size, and the bytes themselves. */
function entriesOf(zip: Buffer): Array<{ name: string; data: Buffer; crc: number }> {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(endAt + 16);
  const out: Array<{ name: string; data: Buffer; crc: number }> = [];
  for (let i = 0; i < zip.readUInt16LE(endAt + 10); i++) {
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const size = zip.readUInt32LE(at + 24);
    const start = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    // the local header, then the name and its extra field, then the bytes
    expect(zip.readUInt32LE(start)).toBe(0x04034b50);
    const dataAt = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
    out.push({ name, data: zip.subarray(dataAt, dataAt + size), crc: zip.readUInt32LE(at + 16) });
    at += 46 + nameLen + extraLen + zip.readUInt16LE(at + 32);
  }
  return out;
}

describe("the streamed zip", () => {
  it("round-trips entries of known and of unknown size, with a central directory that can be read back", async () => {
    const zip = new ZipStream();
    const chunks: Buffer[] = [];
    zip.out.on("data", (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((r) => zip.out.on("end", r));
    const small = Buffer.from("hello, backup", "utf8");
    const big = Buffer.alloc(300_000, 0xab);
    await zip.add("README.txt", Readable.from([small]), new Date(2026, 9, 5, 12, 30), small.length);
    // of unknown size: written as a zip64 entry so that it can hold anything
    await zip.add("files/a/big.bin", Readable.from([big.subarray(0, 100_000), big.subarray(100_000)]), new Date(2026, 9, 5, 12, 31));
    await zip.finish();
    await ended;
    const bytes = Buffer.concat(chunks);
    expect(zipNames(bytes)).toEqual(["README.txt", "files/a/big.bin"]);
    const entries = entriesOf(bytes);
    expect(entries.map((e) => e.name)).toEqual(["README.txt", "files/a/big.bin"]);
    expect(entries[0]!.data.equals(small)).toBe(true);
    expect(entries[1]!.data.equals(big)).toBe(true);
    expect(entries[0]!.crc).toBe(crc32(small));
    expect(entries[1]!.crc).toBe(crc32(big));
    // the entry of unknown size says it needs zip64 (version 45) and carries the zip64 extra field in its local header
    const secondAt = bytes.readUInt32LE(bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16) + 46 + "README.txt".length;
    const start = bytes.readUInt32LE(secondAt + 42);
    expect(bytes.readUInt16LE(start + 4)).toBe(45);
    expect(bytes.readUInt16LE(start + 28)).toBe(20);
    // a small zip has no zip64 end record: a plain reader is enough for it
    expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1);
  });

  it("fails its writer instead of waiting for ever when the reader goes away", async () => {
    const zip = new ZipStream();
    zip.out.destroy();
    await expect(zip.add("x.bin", Readable.from([Buffer.alloc(1024)]))).rejects.toThrow(/cancelled/);
  });
});
