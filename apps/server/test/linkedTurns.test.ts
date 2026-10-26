import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { makeApp, post, type TestApp } from "./helpers";

/**
 * A reading of a linked folder against the moves of its files (review 2026-10-27 D2), who may link from where (S2), a
 * changed file's digest (B24) and how many commits a reading makes (P1).
 */
let dir: string;
let t: TestApp;
const picture = (seed = 1) => Buffer.from(makePng(16, 24, [10 * seed, 20, 30], [40, 50, 60]));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "afflatus-linked-turns-"));
  // walked in this order: a-changed.png, then the directory z
  writeFileSync(join(dir, "a-changed.png"), picture());
  mkdirSync(join(dir, "z"));
  writeFileSync(join(dir, "z", "b.png"), picture(2));
  t = await makeApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const link = async () => (await post(t.app, "/api/folders/link", { path: dir, name: "Shoots" })).json() as { id: string };
const rowOf = (path: string) => t.db.selectFrom("assets").selectAll().where("file_key", "=", `linked:${path}`).executeTakeFirst();
const rowsOf = (path: string) => t.db.selectFrom("assets").selectAll().where("file_key", "=", `linked:${path}`).execute();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Look again held once it reached a-changed.png (changed on the disk, so what was derived from it is forgotten) while
 * `meanwhile` runs, before it walks on to z: what the user did while the directory was being read. `meanwhile` starts
 * from the test, as another request would, not from inside the reading's own turn.
 */
async function lookAgainWhile(root: string, meanwhile: () => Promise<unknown>): Promise<void> {
  utimesSync(join(dir, "a-changed.png"), new Date(), new Date(Date.now() - 3_600_000));
  const changed = (await rowOf(join(dir, "a-changed.png")))!.id;
  let reached!: () => void;
  const atChanged = new Promise<void>((r) => (reached = r));
  let walkOn!: () => void;
  const held = new Promise<void>((r) => (walkOn = r));
  vi.spyOn(t.services.timelines, "forgetDerived").mockImplementation(async (id: string) => {
    if (id !== changed) return;
    reached();
    await held;
  });
  const reading = post(t.app, `/api/folders/${root}/scan`);
  await atChanged;
  await meanwhile();
  walkOn();
  expect((await reading).statusCode).toBe(200);
}

describe("a reading of a linked folder and the moves of its files take turns (D2)", () => {
  it("a file taken to the bin while the folder is read stays in the bin, its copy named by its row", async () => {
    const root = await link();
    const b = (await rowOf(join(dir, "z", "b.png")))!;
    let binning: Promise<void> | undefined;
    await lookAgainWhile(root.id, async () => {
      binning = t.services.linked.toBin(b);
      // the bin's own time to finish, were it not waiting for the reading
      await Promise.race([binning, pause(300)]);
    });
    await binning;
    const after = await t.db.selectFrom("assets").selectAll().where("id", "=", b.id).executeTakeFirst();
    expect(after?.deleted_at).toBeTruthy();
    expect(after?.linked_path).toBe(join(dir, "z", "b.png"));
    expect(await t.services.storage.size(after!.file_key)).toBeGreaterThan(0);
    expect(existsSync(join(dir, "z", "b.png"))).toBe(false);
  });

  it("a file put back from the bin while the folder is read is one item, not two", async () => {
    const root = await link();
    const b = (await rowOf(join(dir, "z", "b.png")))!;
    await t.services.linked.toBin(b);
    const binned = (await t.db.selectFrom("assets").selectAll().where("id", "=", b.id).executeTakeFirst())!;
    let back: Promise<void> | undefined;
    await lookAgainWhile(root.id, async () => {
      back = t.services.linked.restore(binned);
      await Promise.race([back, pause(300)]);
    });
    await back;
    expect(existsSync(join(dir, "z", "b.png"))).toBe(true);
    expect((await rowsOf(join(dir, "z", "b.png"))).map((a) => a.id)).toEqual([b.id]);
  });

  it("a file dropped into the folder while it is read is left to its upload to register", async () => {
    const root = await link();
    const z = (await t.db.selectFrom("folders").selectAll().where("path", "=", join(dir, "z")).executeTakeFirst())!;
    const from = join(dir, "..", `${join(dir).split(/[\\/]/).pop()}-drop.png`);
    writeFileSync(from, picture(3));
    try {
      await lookAgainWhile(root.id, () => t.services.linked.importFile(z, from, "c.png", "image/png"));
      expect(existsSync(join(dir, "z", "c.png"))).toBe(true);
      expect(await rowsOf(join(dir, "z", "c.png"))).toEqual([]);
    } finally {
      rmSync(from, { force: true });
    }
  });

  it("forgets only a row still as the reading found it", async () => {
    const root = await link();
    const b = (await rowOf(join(dir, "z", "b.png")))!;
    // taken to the bin by hand, file and all, between the listing and the forgetting: what the turn now prevents, checked
    // again where the row is deleted
    await lookAgainWhile(root.id, async () => {
      rmSync(join(dir, "z", "b.png"));
      await t.db.updateTable("assets").set({ deleted_at: new Date().toISOString() }).where("id", "=", b.id).execute();
    });
    expect(await t.db.selectFrom("assets").select("id").where("id", "=", b.id).executeTakeFirst()).toBeTruthy();
  });
});

describe("linking from another device (S2)", () => {
  const forwarded = { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" };

  it("is refused behind a proxy on this computer until LINK_ROOTS names what may be linked", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/folders/link", headers: forwarded, payload: { path: dir } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("LINK_ROOTS");
    expect(await t.db.selectFrom("folders").select("id").execute()).toEqual([]);

    // from this computer itself it goes through, and so does a relink; a relink from another device does not
    const root = await link();
    const other = mkdtempSync(join(tmpdir(), "afflatus-linked-turns-other-"));
    try {
      const relink = await t.app.inject({ method: "POST", url: `/api/folders/${root.id}/relink`, headers: forwarded, payload: { path: other } });
      expect(relink.statusCode).toBe(403);
      process.env.LINK_ROOTS = other;
      try {
        expect((await t.app.inject({ method: "POST", url: `/api/folders/${root.id}/relink`, headers: forwarded, payload: { path: other } })).statusCode).toBe(200);
      } finally {
        delete process.env.LINK_ROOTS;
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("a reading of a linked folder", () => {
  it("forgets the digest of a file changed on the disk: a paste of the old content is not found as it (B24)", async () => {
    await link();
    const one = (await rowOf(join(dir, "a-changed.png")))!;
    await t.db.updateTable("assets").set({ digest: "old-digest" }).where("id", "=", one.id).execute();
    writeFileSync(join(dir, "a-changed.png"), Buffer.concat([picture(4), Buffer.alloc(16)]));
    const root = (await t.db.selectFrom("folders").select("id").where("parent_id", "is", null).executeTakeFirstOrThrow()).id;
    await post(t.app, `/api/folders/${root}/scan`);
    expect((await t.db.selectFrom("assets").select("digest").where("id", "=", one.id).executeTakeFirstOrThrow()).digest).toBeNull();
  });

  it("registers a folder's files a slice per transaction, not a commit per file (P1)", async () => {
    for (let i = 0; i < 450; i++) writeFileSync(join(dir, "z", `many-${String(i).padStart(3, "0")}.png`), picture());
    const alone = vi.spyOn(t.db, "insertInto");
    const transactions = vi.spyOn(t.db, "transaction");
    await link();
    expect(await t.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).toEqual({ n: 452 });
    // every asset row inside a transaction (the folder's own row and its sub-directories' are written outside)
    expect(alone.mock.calls.filter(([table]) => table === "assets")).toEqual([]);
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(3);

    // and the 450 gone at once: forgotten a slice at a time too
    for (const f of readdirSync(join(dir, "z"))) if (f.startsWith("many-")) rmSync(join(dir, "z", f));
    const deletes = vi.spyOn(t.db, "deleteFrom");
    const root = (await t.db.selectFrom("folders").select("id").where("parent_id", "is", null).executeTakeFirstOrThrow()).id;
    await post(t.app, `/api/folders/${root}/scan`);
    expect(await t.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).toEqual({ n: 2 });
    expect(deletes.mock.calls.filter(([table]) => table === "assets")).toEqual([]);
  });
});
