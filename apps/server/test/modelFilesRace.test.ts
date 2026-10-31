import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { moveNoClobber, type BinFinder } from "../src/modelBin";
import { deleteFiles, emptyAway, putBack, type Library } from "../src/modelLibrary";
import { writeSettings } from "../src/settings";
import { CHECKPOINT, get, makeApp, referenceCatalog, type TestApp } from "./helpers";

/**
 * Settings › Model files where the disk answers in an unlucky order (release review 0.9.0): a name removed between a move's
 * link and its unlink (D6), and a file system that gives two files one index (D7). node:fs/promises is wrapped for this
 * file only: `hooks.afterLink` runs once a link is made, `hooks.ino` gives a file another index. All in temporary folders.
 */
const hooks = vi.hoisted(() => ({ afterLink: null as null | ((from: string, to: string) => Promise<void>), ino: null as null | ((path: string) => bigint | null) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const link: typeof real.link = async (from, to) => {
    await real.link(from, to);
    await hooks.afterLink?.(String(from), String(to));
  };
  const stat = (async (path: Parameters<typeof real.stat>[0], opts?: Parameters<typeof real.stat>[1]) => {
    const st = await real.stat(path, opts as never);
    const ino = hooks.ino?.(String(path));
    if (ino === null || ino === undefined || typeof st.ino !== "bigint") return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as typeof st, st, { ino });
  }) as typeof real.stat;
  return { ...real, default: { ...real, link, stat }, link, stat };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "afflatus-race-"));
});
afterEach(() => {
  hooks.afterLink = null;
  hooks.ino = null;
  rmSync(home, { recursive: true, force: true });
});

describe("a move whose old name goes as it is made (D6)", () => {
  it("keeps the new name, the only one the file has left, rather than rolling back over nothing", async () => {
    const from = join(home, "a.safetensors");
    const to = join(home, "b.safetensors");
    writeFileSync(from, "zz-test bytes");
    // an Empty erasing the old name the moment the link is made
    hooks.afterLink = async (a) => rmSync(a);
    await moveNoClobber(from, to);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("zz-test bytes");
  });
});

describe("Model files with an app (D6, D7)", () => {
  let t: TestApp;
  let comfy: FakeComfy;
  const fake: BinFinder = async () => ({ dir: join(home, "bin"), room: 1e9 });
  const vae = () => join(home, "models", "vae", "zz-test-vae.safetensors");
  beforeEach(async () => {
    mkdirSync(join(home, "bin"));
    for (const f of ["checkpoints", "loras", "vae"]) mkdirSync(join(home, "models", f), { recursive: true });
    writeFileSync(join(home, "models", "checkpoints", CHECKPOINT), Buffer.alloc(4000, 1));
    writeFileSync(vae(), Buffer.alloc(200, 3));
    comfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
    t = await makeApp({ comfyUrl: comfy.url });
    await writeSettings(t.db, { comfyDir: home });
  });
  afterEach(async () => {
    await t.close();
    await comfy.close().catch(() => {});
  });

  it("runs Put back and Empty one at a time: an Empty asked as a file is being put back never erases it", async () => {
    const done = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    expect(done.moved).toBe(1);
    await t.services.hashes.run();
    // the user's Empty, the moment Put back has linked the file back: given a moment to run before Put back goes on. Asked
    // from the test's own context (another request), never from inside Put back's turn, where it would run in that turn
    let linked!: () => void;
    const atLink = new Promise<void>((r) => (linked = r));
    const emptied = atLink.then(() => emptyAway(t.services));
    hooks.afterLink = async (_from, to) => {
      if (to !== vae()) return;
      hooks.afterLink = null;
      linked();
      await Promise.race([emptied, new Promise((r) => setTimeout(r, 300))]);
    };
    expect(await putBack(t.services, { batch: done.batch })).toEqual({ back: 1, left: [] });
    expect(await emptied).toEqual({ erased: 0, bytes: 0 });
    expect(readFileSync(vae())).toEqual(Buffer.alloc(200, 3));
    expect(await t.db.selectFrom("model_removed").select(["restored_at", "emptied_at"]).executeTakeFirstOrThrow()).toEqual({ restored_at: expect.any(String), emptied_at: null });
  });

  it("tells two files apart that the file system gives one index, by their sizes: two rows, each its own hash", async () => {
    const a = join(home, "models", "loras", "zz-clash-a.safetensors");
    const b = join(home, "models", "loras", "zz-clash-b.safetensors");
    writeFileSync(a, Buffer.alloc(300, 51));
    writeFileSync(b, Buffer.alloc(500, 52));
    hooks.ino = (p) => (basename(p).startsWith("zz-clash-") ? 4242n : null);
    await t.services.hashes.run();
    const l = (await get(t.app, "/api/model-files")).json() as Library;
    const rows = l.files.filter((f) => !f.removed && f.file.startsWith("zz-clash-"));
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").toUpperCase();
    expect(rows.map((f) => [f.file, f.size, f.also, f.sha256]).sort()).toEqual([["zz-clash-a.safetensors", 300, [], sha(a)], ["zz-clash-b.safetensors", 500, [], sha(b)]]);
    // a Delete of one is the one alone
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-clash-a.safetensors" }], to: "aside" }, fake);
    expect(done).toMatchObject({ moved: 1, also: [] });
    expect(existsSync(b)).toBe(true);
    const after = (await get(t.app, "/api/model-files")).json() as Library;
    expect(after.files.filter((f) => !f.removed).map((f) => f.file)).toContain("zz-clash-b.safetensors");
  });
});
