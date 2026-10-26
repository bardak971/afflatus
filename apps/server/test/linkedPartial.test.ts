import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { makeApp, post, type TestApp } from "./helpers";

/** A copy that fails half way, as on a full disk: half the bytes are written, then ENOSPC. */
const failing = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (from: string, to: string, mode?: number) => {
      if (!failing.on) return fs.copyFile(from, to, mode);
      const bytes = await fs.readFile(from);
      await fs.writeFile(to, bytes.subarray(0, bytes.length >> 1));
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
  };
});

let dir: string;
let t: TestApp;
const picture = () => Buffer.from(makePng(16, 24, [10, 20, 30], [40, 50, 60]));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "afflatus-linked-partial-"));
  writeFileSync(join(dir, "one.png"), picture());
  t = await makeApp();
});
afterEach(async () => {
  failing.on = false;
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a file written into a linked folder that fails half way (D5)", () => {
  it("leaves nothing in the folder, filed or put back from the bin, and the item where it was", async () => {
    const root = (await post(t.app, "/api/folders/link", { path: dir, name: "Shoots" })).json() as { id: string };
    const mine = (await t.app.inject({ method: "POST", url: "/api/assets?name=loose.png", headers: { "content-type": "image/png" }, payload: picture() })).json() as { id: string };
    const before = (await t.db.selectFrom("assets").select("file_key").where("id", "=", mine.id).executeTakeFirstOrThrow()).file_key;

    failing.on = true;
    expect((await post(t.app, "/api/assets/move", { ids: [mine.id], folderId: root.id })).statusCode).toBeGreaterThanOrEqual(400);
    expect(readdirSync(dir)).toEqual(["one.png"]);
    expect((await t.db.selectFrom("assets").select("file_key").where("id", "=", mine.id).executeTakeFirstOrThrow()).file_key).toBe(before);

    // a linked file in the bin, put back on a full disk
    failing.on = false;
    const one = (await t.db.selectFrom("assets").select("id").where("name", "=", "one.png").executeTakeFirstOrThrow()).id;
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${one}` })).statusCode).toBe(200);
    expect(readdirSync(dir)).toEqual([]);
    failing.on = true;
    expect((await t.app.inject({ method: "POST", url: `/api/assets/${one}/restore` })).statusCode).toBeGreaterThanOrEqual(400);
    expect(readdirSync(dir)).toEqual([]);
    // the next reading registers nothing
    failing.on = false;
    await post(t.app, `/api/folders/${root.id}/scan`);
    expect(await t.db.selectFrom("assets").select("id").where("file_key", "like", "linked:%").execute()).toEqual([]);
  });
});
