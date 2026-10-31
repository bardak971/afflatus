import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { sql } from "kysely";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { now } from "../src/db";
import { ASIDE_DIR, type BinFinder } from "../src/modelBin";
import { addFile, badName, deleteFiles, folderOfHeader, settleAway, settlePending, type Library } from "../src/modelLibrary";
import { backfillUses, recordUses } from "../src/modelUses";
import { writeSettings } from "../src/settings";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Settings › Model files (modelLibrary.ts): every model file of ComfyUI's folders with its uses, what needs it, and Delete,
 * Put back, Empty and the drop. Every file is in the test's own temporary folder; Delete goes to a stand-in bin or the
 * set-aside folder, never to a real Recycle Bin.
 */

let t: TestApp;
let comfy: FakeComfy;
let home: string;
let bin: string;
const fake: BinFinder = async () => ({ dir: bin, room: 1e9 });
const lib = async (q = "") => (await get(t.app, `/api/model-files${q}`)).json() as Library;
const byFile = (l: Library, file: string) => l.files.find((f) => f.file === file && !f.removed);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "afflatus-library-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  for (const f of ["checkpoints", "loras/style", "vae"]) mkdirSync(join(home, "models", f), { recursive: true });
  writeFileSync(join(home, "models", "checkpoints", CHECKPOINT), Buffer.alloc(4000, 1));
  writeFileSync(join(home, "models", "loras", "style", "zz-test-a.safetensors"), Buffer.alloc(300, 2));
  writeFileSync(join(home, "models", "loras", "zz-test-copy.safetensors"), Buffer.alloc(300, 2));
  writeFileSync(join(home, "models", "vae", "zz-test-vae.safetensors"), Buffer.alloc(200, 3));
  comfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
  t = await makeApp({ comfyUrl: comfy.url });
  await writeSettings(t.db, { comfyDir: home });
});
afterEach(async () => {
  await t.close();
  await comfy.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

describe("the list", () => {
  it("has every file with its kind, size and date; copies once hashed; uses by name until then, by hash after", async () => {
    let l = await lib();
    expect(l.readOnly).toBe(false);
    expect(l.files.map((f) => `${f.kind}:${f.file}`).sort()).toEqual(["Checkpoint:illustrious.safetensors", "LoRA:style/zz-test-a.safetensors", "LoRA:zz-test-copy.safetensors", "VAE:zz-test-vae.safetensors"]);
    expect(byFile(l, CHECKPOINT)).toMatchObject({ size: 4000, match: "pending", sha256: null, uses: 0, last: null, path: join(home, "models", "checkpoints", CHECKPOINT) });
    await recordUses(t.db, { id: "job-1", machine_id: null }, [{ folder: "loras", file: "style/zz-test-a.safetensors", node: "1", classType: "LoraLoader", input: "lora_name" }]);
    expect(byFile(await lib(), "style/zz-test-a.safetensors")).toMatchObject({ uses: 1, approx: false });
    await t.services.hashes.run();
    l = await lib();
    const a = byFile(l, "style/zz-test-a.safetensors")!;
    expect(a.sha256).toMatch(/^[0-9A-F]{64}$/);
    expect(a.copies).toEqual(["loras|zz-test-copy.safetensors"]);
    // the use was noted before the file was hashed: still its own by its name
    expect(a.uses).toBe(1);
    await recordUses(t.db, { id: "job-2", machine_id: null }, [{ folder: "loras", file: "style/zz-test-a.safetensors", node: "1", classType: "LoraLoader", input: "lora_name" }]);
    // the same job twice (submitted again after a restart) is one use
    await recordUses(t.db, { id: "job-2", machine_id: null }, [{ folder: "loras", file: "style/zz-test-a.safetensors", node: "1", classType: "LoraLoader", input: "lora_name" }]);
    l = await lib();
    expect(byFile(l, "style/zz-test-a.safetensors")!.uses).toBe(2);
    // its copy, the same bytes elsewhere, has uses of its own only
    expect(byFile(l, "zz-test-copy.safetensors")!.uses).toBe(0);
    // renamed, the file keeps the uses noted with its hash (the one from before it was hashed knew only its name)
    renameSync(join(home, "models", "loras", "style", "zz-test-a.safetensors"), join(home, "models", "loras", "style", "zz-test-renamed.safetensors"));
    await t.services.hashes.run();
    l = await lib();
    expect(byFile(l, "style/zz-test-renamed.safetensors")!.uses + byFile(l, "zz-test-copy.safetensors")!.uses).toBe(1);
  });

  it("says what needs a file: a model set, and Delete leaves it unless told Delete all", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], files: [{ folder: "vae", file: "zz-test-vae.safetensors" }] })).json();
    expect(byFile(await lib(), "zz-test-vae.safetensors")!.needs).toEqual([{ kind: "set", id: set.id, name: "zz-test set" }]);
    const kept = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    expect(kept).toMatchObject({ moved: 0, left: [{ file: "zz-test-vae.safetensors", why: "the model set zz-test set needs it" }] });
    const gone = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside", anyway: true }, fake);
    expect(gone).toMatchObject({ moved: 1, bytes: 200 });
    expect(existsSync(join(home, "models", ASIDE_DIR, "vae", "zz-test-vae.safetensors"))).toBe(true);
  });
});

describe("Delete, Put back and Empty", () => {
  it("moves to the bin, lists the file greyed, puts a whole Delete back (Undo), and Empty erases what is away", async () => {
    const done = await deleteFiles(t.services, { files: [{ folder: "checkpoints", file: CHECKPOINT }, { folder: "loras", file: "zz-test-copy.safetensors" }], to: "bin" }, fake);
    expect(done).toMatchObject({ moved: 2, bytes: 4300, aside: [], left: [] });
    expect(readdirSync(bin).filter((n) => n.startsWith("$R"))).toHaveLength(2);
    let l = await lib();
    expect(byFile(l, CHECKPOINT)).toBeUndefined();
    expect(l.files.filter((f) => f.removed).map((f) => [f.file, f.removed!.place])).toEqual(expect.arrayContaining([[CHECKPOINT, "bin"], ["zz-test-copy.safetensors", "bin"]]));
    expect(l.away).toEqual({ bin: 4300, aside: 0, files: 2 });
    expect((await post(t.app, "/api/model-files/put-back", { batch: done.batch })).json()).toEqual({ back: 2, left: [] });
    expect(readFileSync(join(home, "models", "checkpoints", CHECKPOINT))).toEqual(Buffer.alloc(4000, 1));
    expect(readdirSync(bin)).toEqual([]);
    // the set-aside folder now (the route's own: asked for it), then Empty
    const aside = (await post(t.app, "/api/model-files/delete", { files: [{ folder: "loras", file: "style/zz-test-a.safetensors" }], to: "aside" })).json();
    expect(aside).toMatchObject({ moved: 1 });
    l = await lib();
    expect(l.away).toEqual({ bin: 0, aside: 300, files: 1 });
    expect((await post(t.app, "/api/model-files/empty", {})).json()).toEqual({ erased: 1, bytes: 300 });
    expect(existsSync(join(home, "models", ASIDE_DIR))).toBe(false);
    expect((await lib()).away).toEqual({ bin: 0, aside: 0, files: 0 });
  });

  it("takes a file found back in its place (Explorer's Restore) as put back, one gone from the bin as emptied", async () => {
    const done = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }, { folder: "loras", file: "zz-test-copy.safetensors" }], to: "bin" }, fake);
    const rows = await t.db.selectFrom("model_removed").selectAll().where("batch", "=", done.batch).execute();
    const vae = rows.find((r) => r.folder === "vae")!;
    const lora = rows.find((r) => r.folder === "loras")!;
    // Explorer's Restore puts the file back itself; Windows' Empty erases the other
    writeFileSync(vae.path_was, readFileSync(vae.stored_path));
    rmSync(vae.stored_path);
    rmSync(lora.stored_path);
    expect((await lib()).away.files).toBe(0);
    // the list only reads: a write (here the hourly pass) says so
    await settleAway(t.services);
    const after = await t.db.selectFrom("model_removed").selectAll().execute();
    expect(after.find((r) => r.id === vae.id)!.restored_at).not.toBeNull();
    expect(after.find((r) => r.id === lora.id)!.emptied_at).not.toBeNull();
  });

  it("is never offered on a file outside the folders, nor over one already there when a file is dropped", async () => {
    const out = await deleteFiles(t.services, { files: [{ folder: "loras", file: "../checkpoints/illustrious.safetensors" }], to: "aside" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: expect.stringContaining("not in ComfyUI's folders") }] });
    expect(existsSync(join(home, "models", "checkpoints", CHECKPOINT))).toBe(true);
    const put = (name: string, body: string) => t.app.inject({ method: "PUT", url: `/api/model-files/add?folder=loras&name=${encodeURIComponent(name)}`, headers: { "content-type": "application/x-afflatus-model" }, payload: body });
    const added = await put("zz-test-new.safetensors", "abc");
    expect(added.json()).toEqual({ file: "zz-test-new.safetensors", bytes: 3 });
    expect(readFileSync(join(home, "models", "loras", "zz-test-new.safetensors"), "utf8")).toBe("abc");
    expect((await put("zz-test-new.safetensors", "def")).statusCode).toBe(409);
    expect((await put("../zz-test-out.safetensors", "x")).json()).toEqual({ file: "zz-test-out.safetensors", bytes: 1 });
    expect(existsSync(join(home, "models", "zz-test-out.safetensors"))).toBe(false);
    expect((await put("notes.txt", "x")).statusCode).toBe(400);
  });
});

describe("a dropped file's folder", () => {
  const header = (names: string[]) => Object.fromEntries(names.map((n) => [n, { dtype: "F16", shape: [4, 4], data_offsets: [0, 32] }]));
  it("is read from its header's tensors, null when they do not tell", () => {
    expect(folderOfHeader(header(["lora_unet_down_blocks_0.lora_down.weight"]))).toBe("loras");
    expect(folderOfHeader(header(["model.diffusion_model.input_blocks.0.0.weight", "first_stage_model.decoder.conv_in.weight"]))).toBe("checkpoints");
    expect(folderOfHeader(header(["encoder.down.0.block.0.conv1.weight", "decoder.up.0.block.0.conv1.weight"]))).toBe("vae");
    expect(folderOfHeader(header(["encoder.block.0.layer.0.SelfAttention.q.weight", "shared.weight"]))).toBe("text_encoders");
    expect(folderOfHeader(header(["something.else"]))).toBeNull();
    expect(folderOfHeader(null)).toBeNull();
  });
});

describe("uses", () => {
  it("are the files a job's graph loads, noted as it is sent, with the takes it made; the backfill counts the renders from before", async () => {
    await t.services.queue.start();
    await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "a pier in the fog", checkpoint: CHECKPOINT } });
    await until(() => comfy.prompts.size === 1);
    complete(comfy, [...comfy.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("assets").select("id").execute()).length === 1);
    const uses = await t.db.selectFrom("model_uses").selectAll().execute();
    expect(uses).toEqual([expect.objectContaining({ folder: "checkpoints", file: CHECKPOINT, exact: 1, generation_id: expect.any(String) })]);
    expect(byFile(await lib(), CHECKPOINT)).toMatchObject({ uses: 1, takes: 1, families: ["sdxl"] });
    // a render from before 0.8.2: its generation is counted once by the backfill, its job's own row left alone
    const g = (await t.db.selectFrom("generations").selectAll().execute())[0]!;
    await t.db.insertInto("generations").values({ ...g, id: "gen-old", created_at: "2026-07-01T10:00:00.000Z" }).execute();
    expect(await backfillUses(t.services)).toBe(1);
    expect(await backfillUses(t.services)).toBe(0);
    const old = await t.db.selectFrom("model_uses").selectAll().where("generation_id", "=", "gen-old").execute();
    expect(old).toEqual([expect.objectContaining({ job_id: "gen:gen-old", file: CHECKPOINT, exact: 1, used_at: "2026-07-01T10:00:00.000Z" })]);
    const l = await lib();
    expect(byFile(l, CHECKPOINT)).toMatchObject({ uses: 2, months: { "2026-07": 1, [now().slice(0, 7)]: 1 } });
    expect(l.since).toBe("2026-07-01T10:00:00.000Z");
  });
});

describe("what the review asked to hold (card #155)", () => {
  const vae = () => join(home, "models", "vae", "zz-test-vae.safetensors");

  it("never replaces a file arriving under the same name while a drop is sent, nor removes another drop's .part", async () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const a = addFile(t.services, "loras", "zz-test-same.safetensors", first).then(() => "added", (err: Error) => err.message);
    first.write("first ");
    await until(() => readdirSync(join(home, "models", "loras")).some((n) => n.endsWith(".part")));
    // a second drop of the same name, done first: the first one's .part is left alone
    const b = addFile(t.services, "loras", "zz-test-same.safetensors", second).then(() => "added", (err: Error) => err.message);
    second.end("second");
    expect(await b).toBe("added");
    expect(readdirSync(join(home, "models", "loras")).filter((n) => n.endsWith(".part"))).toHaveLength(1);
    first.end("half");
    expect(await a).toMatch(/already/);
    expect(readFileSync(join(home, "models", "loras", "zz-test-same.safetensors"), "utf8")).toBe("second");
    expect(readdirSync(join(home, "models", "loras")).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("refuses names Windows cannot hold or holds as something else", async () => {
    for (const name of ["CON.safetensors", "nul.safetensors", "a:b.safetensors", "x.safetensors.", "x.safetensors ", "lpt1.pt"]) expect(badName(name), name).not.toBeNull();
    expect(badName("zz-test ok.safetensors")).toBeNull();
    const put = (name: string) => t.app.inject({ method: "PUT", url: `/api/model-files/add?folder=loras&name=${encodeURIComponent(name)}`, headers: { "content-type": "application/x-afflatus-model" }, payload: "x" });
    expect((await put("CON.safetensors")).statusCode).toBe(400);
    expect((await put("a:b.safetensors")).statusCode).toBe(400);
    expect(readdirSync(join(home, "models", "loras")).filter((n) => /^(CON|a)/.test(n))).toEqual([]);
  });

  it("deletes model files only: a .json or .yaml beside them stays", async () => {
    writeFileSync(join(home, "models", "loras", "config.json"), "{}");
    const out = await deleteFiles(t.services, { files: [{ folder: "loras", file: "config.json" }], to: "aside" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: "it is not a model file" }] });
    expect(existsSync(join(home, "models", "loras", "config.json"))).toBe(true);
  });

  it("puts a file back when its row cannot say it moved, and settles a move cut short at the next start", async () => {
    await sql`CREATE TRIGGER zz_refuse BEFORE UPDATE OF pending ON model_removed BEGIN SELECT RAISE(ABORT, 'zz-test refused'); END`.execute(t.db);
    const out = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "bin" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: expect.stringContaining("zz-test refused") }] });
    expect(readFileSync(vae())).toEqual(Buffer.alloc(200, 3));
    expect(readdirSync(bin)).toEqual([]);
    expect(await t.db.selectFrom("model_removed").selectAll().execute()).toEqual([]);
    await sql`DROP TRIGGER zz_refuse`.execute(t.db);
    // a stop between the row and its end: the file where it was going, the row still pending
    const stored = join(bin, "$RZZZZZZ.safetensors");
    const row = { batch: "b", folder: "vae", file: "zz-test-vae.safetensors", path_was: vae(), size: 200, sha256: null, place: "bin" as const, info_path: null, removed_at: now(), restored_at: null, emptied_at: null, pending: 1 };
    await t.db.insertInto("model_removed").values({ ...row, id: "moved", stored_path: stored }).execute();
    renameSync(vae(), stored);
    await t.db.insertInto("model_removed").values({ ...row, id: "never", stored_path: join(bin, "$RYYYYYY.safetensors"), path_was: join(home, "models", "checkpoints", CHECKPOINT) }).execute();
    await settlePending(t.services);
    const rows = await t.db.selectFrom("model_removed").select(["id", "pending"]).execute();
    expect(rows).toEqual([{ id: "moved", pending: 0 }]);
    expect((await post(t.app, "/api/model-files/put-back", { ids: ["moved"] })).json()).toEqual({ back: 1, left: [] });
    expect(existsSync(vae())).toBe(true);
  });

  it("keeps a file whose drive is away as away; reading the list writes nothing", async () => {
    const done = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    expect(done.moved).toBe(1);
    // its set-aside folder gone for now (an unplugged drive): neither emptied nor put back
    const aside = join(home, "models", ASIDE_DIR);
    renameSync(aside, join(home, "unplugged"));
    expect((await lib()).away.files).toBe(1);
    await settleAway(t.services);
    expect((await t.db.selectFrom("model_removed").select(["emptied_at", "restored_at"]).executeTakeFirst())).toEqual({ emptied_at: null, restored_at: null });
    expect((await post(t.app, "/api/model-files/empty", {})).json()).toEqual({ erased: 0, bytes: 0 });
    renameSync(join(home, "unplugged"), aside);
    // put back by hand: the list leaves it out, and only a write says so
    renameSync(join(aside, "vae", "zz-test-vae.safetensors"), vae());
    expect((await lib()).away.files).toBe(0);
    expect((await t.db.selectFrom("model_removed").select("restored_at").executeTakeFirst())!.restored_at).toBeNull();
    await settleAway(t.services);
    expect((await t.db.selectFrom("model_removed").select("restored_at").executeTakeFirst())!.restored_at).not.toBeNull();
  });

  it("leaves a helper file a running job's graph loads, though no form names it", async () => {
    await t.db.insertInto("jobs").values({ id: "zz-running", owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status: "running", priority: 0, created_at: now(), updated_at: now() } as never).execute();
    await recordUses(t.db, { id: "zz-running" }, [{ folder: "vae", file: "zz-test-vae.safetensors", node: "1", classType: "VAELoader", input: "vae_name" }]);
    const out = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: "a job waiting or running uses it" }] });
    expect(existsSync(vae())).toBe(true);
  });
});

describe("one file seen through two folders (card #164)", () => {
  /**
   * The owner's extra_model_paths.yaml as on 2026-10-30, in the test's folder: A1111's Stable-diffusion as checkpoints and
   * its Krea2 sub-folder as diffusion_models, and A1111's models/unet named as diffusion_models with forward slashes
   * where ComfyUI reads its own models/unet as diffusion_models too. Each is one file on disk seen in two places.
   */
  const KREA = "zz-test-krea.safetensors";
  const UNET = "zz-test-unet.safetensors";
  beforeEach(() => {
    mkdirSync(join(home, "a1111", "Stable-diffusion", "Krea2"), { recursive: true });
    mkdirSync(join(home, "models", "unet"), { recursive: true });
    writeFileSync(join(home, "a1111", "Stable-diffusion", "Krea2", KREA), Buffer.alloc(5000, 7));
    writeFileSync(join(home, "models", "unet", UNET), Buffer.alloc(6000, 8));
    const base = home.replace(/\\/g, "/");
    writeFileSync(join(home, "extra_model_paths.yaml"), [
      "a1111:", `  base_path: ${base}/a1111`, "  checkpoints: Stable-diffusion",
      "a1111_diffusion_models:", `  base_path: ${base}/a1111`, "  diffusion_models: Stable-diffusion/Krea2",
      "a1111_unet:", `  base_path: ${base}`, "  diffusion_models: models/unet", "",
    ].join("\n"));
  });
  const rowsOf = (l: Library, name: string) => l.files.filter((f) => !f.removed && (f.file.endsWith(name) || (f.also ?? []).some((a) => a.file.endsWith(name))));

  it("lists it once with its places, never as its own copy; hashes it once; a real copy (another file, same bytes) stays a copy", async () => {
    await t.services.hashes.run();
    const l = await lib();
    const krea = rowsOf(l, KREA);
    expect(krea).toHaveLength(1);
    expect([`${krea[0]!.folder}/${krea[0]!.file}`, ...krea[0]!.also.map((a) => `${a.folder}/${a.file}`)].sort()).toEqual([`checkpoints/Krea2/${KREA}`, `diffusion_models/${KREA}`]);
    expect(krea[0]!.copies).toEqual([]);
    expect(krea[0]!.sha256).toMatch(/^[0-9A-F]{64}$/);
    const unet = rowsOf(l, UNET);
    expect(unet).toHaveLength(1);
    expect(unet[0]!.copies).toEqual([]);
    // its size counts once in the whole
    expect(l.files.filter((f) => !f.removed).reduce((n, f) => n + (f.size ?? 0), 0)).toBe(4000 + 300 + 300 + 200 + 5000 + 6000);
    // both places know its hash, the second given it without reading the file again (the same hashed_at moment's row)
    const rows = await t.db.selectFrom("model_hashes").selectAll().where("file", "in", [`Krea2/${KREA}`, KREA]).execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.sha256).toBe(rows[1]!.sha256);
    // the two LoRAs are two files with the same bytes: copies of each other
    expect(byFile(l, "zz-test-copy.safetensors")!.copies).toEqual(["loras|style/zz-test-a.safetensors"]);
    expect(byFile(l, "zz-test-copy.safetensors")!.also).toEqual([]);
  });

  it("Delete never takes it for its own copy: a model set naming it in the other place stops it; moved once, said from every place", async () => {
    await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], files: [{ folder: "diffusion_models", file: KREA }] });
    const kept = await deleteFiles(t.services, { files: [{ folder: "checkpoints", file: `Krea2/${KREA}` }], to: "aside" }, fake);
    expect(kept).toMatchObject({ moved: 0, left: [{ file: KREA, why: "the model set zz-test set needs it" }] });
    expect(existsSync(join(home, "a1111", "Stable-diffusion", "Krea2", KREA))).toBe(true);
    // both places asked (as a "Select" of both rows on an older page did): one move, not a second "not there any more"
    const gone = await deleteFiles(t.services, { files: [{ folder: "checkpoints", file: `Krea2/${KREA}` }, { folder: "diffusion_models", file: KREA }], to: "aside", anyway: true }, fake);
    expect(gone).toMatchObject({ moved: 1, bytes: 5000, left: [], also: [{ file: KREA, as: [`diffusion_models/${KREA}`] }] });
    const l = await lib();
    expect(rowsOf(l, KREA)).toEqual([]);
    expect(l.files.filter((f) => f.removed)).toHaveLength(1);
  });

  it("Empty's list says a file with no other copy left as the only copy; one whose copy stays names it", async () => {
    await t.services.hashes.run();
    await deleteFiles(t.services, { files: [{ folder: "diffusion_models", file: UNET }, { folder: "loras", file: "zz-test-copy.safetensors" }], to: "aside" }, fake);
    const away = (await lib()).files.filter((f) => f.removed);
    expect(away.map((f) => [f.file, f.copies]).sort()).toEqual([["zz-test-copy.safetensors", ["loras|style/zz-test-a.safetensors"]], [UNET, []]]);
  });

  it("is one file through a junction too (a folder linked into another)", async () => {
    if (process.platform !== "win32") return;
    const real = join(home, "lora-store");
    mkdirSync(real);
    writeFileSync(join(real, "zz-test-linked.safetensors"), Buffer.alloc(700, 9));
    symlinkSync(real, join(home, "models", "loras", "linked"), "junction");
    writeFileSync(join(home, "extra_model_paths.yaml"), ["store:", `  base_path: ${home.replace(/\\/g, "/")}`, "  loras: lora-store", ""].join("\n"));
    const l = await lib();
    const rows = rowsOf(l, "zz-test-linked.safetensors");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.also).toHaveLength(1);
    expect(rows[0]!.copies).toEqual([]);
  });
});

describe("the files Delete moved, never a file in place nor a copy that stays (card #185)", () => {
  /**
   * A junction to a folder above a model folder, as `models/checkpoints/a1111` → A1111's models with A1111's Lora as
   * loras: the set-aside folder made beside that Lora folder is reached through it. Junctions on Windows, directory links
   * elsewhere; all in the test's folder.
   */
  const X = "zz-test-x.safetensors";
  beforeEach(() => {
    mkdirSync(join(home, "a1111", "models", "Lora"), { recursive: true });
    writeFileSync(join(home, "a1111", "models", "Lora", X), Buffer.alloc(900, 11));
    writeFileSync(join(home, "extra_model_paths.yaml"), ["a1111:", `  base_path: ${home.replace(/\\/g, "/")}/a1111`, "  loras: models/Lora", ""].join("\n"));
    symlinkSync(join(home, "a1111", "models"), join(home, "models", "checkpoints", "a1111"), "junction");
  });
  const live = (l: Library) => l.files.filter((f) => !f.removed);

  it("never lists a set-aside file reached through a junction: the removed one has no copy, Empty erases its only copy", async () => {
    await t.services.hashes.run();
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: X }], to: "aside" }, fake);
    expect(done).toMatchObject({ moved: 1, left: [] });
    expect(existsSync(join(home, "a1111", "models", ASIDE_DIR, "loras", X))).toBe(true);
    await t.services.hashes.run();
    const l = await lib();
    expect(live(l).filter((f) => f.file.includes(ASIDE_DIR) || f.also.some((a) => a.file.includes(ASIDE_DIR)))).toEqual([]);
    const away = l.files.filter((f) => f.removed);
    expect(away.map((f) => [f.file, f.copies])).toEqual([[X, []]]);
    // nor hashed there, nor offered to Delete by its path through the junction
    expect((await t.db.selectFrom("model_hashes").select("file").execute()).filter((r) => r.file.includes(ASIDE_DIR))).toEqual([]);
    const again = await deleteFiles(t.services, { files: [{ folder: "checkpoints", file: `a1111/${ASIDE_DIR}/loras/${X}` }], to: "aside" }, fake);
    expect(again).toMatchObject({ moved: 0 });
    expect(existsSync(join(home, "a1111", "models", ASIDE_DIR, "loras", X))).toBe(true);
  });

  it("never lists a file in a drive's Recycle Bin reached through a junction", async () => {
    const recycle = join(home, "a1111", "models", "$RECYCLE.BIN", "S-1-5-21-0");
    mkdirSync(recycle, { recursive: true });
    const inBin: BinFinder = async () => ({ dir: recycle, room: 1e9 });
    await t.services.hashes.run();
    expect(await deleteFiles(t.services, { files: [{ folder: "loras", file: X }], to: "bin" }, inBin)).toMatchObject({ moved: 1, aside: [] });
    await t.services.hashes.run();
    const l = await lib();
    expect(live(l).filter((f) => /\$recycle\.bin/i.test([f.file, ...f.also.map((a) => a.file)].join("|")))).toEqual([]);
    expect(l.files.filter((f) => f.removed).map((f) => f.copies)).toEqual([[]]);
  });

  it("walks a junction to its own parent once, not round and round", async () => {
    symlinkSync(join(home, "models", "loras"), join(home, "models", "loras", "loop"), "junction");
    const l = await lib();
    expect(live(l).filter((f) => f.file.startsWith("loop/") || f.also.some((a) => a.file.startsWith("loop/")))).toEqual([]);
    expect(byFile(l, "zz-test-copy.safetensors")!.also).toEqual([]);
  });

  it("takes each name of a hard-linked file as its own place: Delete moves one, the other stays listed", async () => {
    writeFileSync(join(home, "models", "loras", "zz-test-h1.safetensors"), Buffer.alloc(400, 5));
    linkSync(join(home, "models", "loras", "zz-test-h1.safetensors"), join(home, "models", "loras", "style", "zz-test-h2.safetensors"));
    await t.services.hashes.run();
    let l = await lib();
    expect(byFile(l, "zz-test-h1.safetensors")).toMatchObject({ also: [], copies: ["loras|style/zz-test-h2.safetensors"] });
    expect(byFile(l, "style/zz-test-h2.safetensors")).toMatchObject({ also: [], copies: ["loras|zz-test-h1.safetensors"] });
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-test-h1.safetensors" }], to: "aside" }, fake);
    expect(done).toMatchObject({ moved: 1, also: [] });
    l = await lib();
    expect(byFile(l, "style/zz-test-h2.safetensors")).toMatchObject({ size: 400 });
    expect(l.files.filter((f) => f.removed).map((f) => [f.file, f.copies])).toEqual([["zz-test-h1.safetensors", ["loras|style/zz-test-h2.safetensors"]]]);
  });

  it("keeps two files of one name in two of a folder's directories apart: each its own row, hash, Delete and Put back", async () => {
    // ComfyUI loads models/loras' one by the name; A1111's Lora holds another file under it, other bytes (the junction
    // to A1111's models left out: through it, that file is a checkpoint's name of its own)
    // the link itself, not what it leads to: a junction on Windows, a symlink elsewhere (rmdir refuses one on Linux)
    rmSync(join(home, "models", "checkpoints", "a1111"));
    const mine = join(home, "models", "loras", "zz-test-dup.safetensors");
    const other = join(home, "a1111", "models", "Lora", "zz-test-dup.safetensors");
    writeFileSync(mine, Buffer.alloc(500, 31));
    writeFileSync(other, Buffer.alloc(500, 32));
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").toUpperCase();
    const [shaMine, shaOther] = [sha(mine), sha(other)];
    await t.services.hashes.run();
    const rowOf = (l: Library, path: string) => live(l).find((f) => f.path === path);
    let l = await lib();
    expect(rowOf(l, mine)).toMatchObject({ id: "loras|zz-test-dup.safetensors", sha256: shaMine, copies: [] });
    expect(rowOf(l, other)).toMatchObject({ id: `loras|zz-test-dup.safetensors|${other}`, sha256: shaOther, copies: [] });
    // the name's hash is the file ComfyUI loads; the other one's is kept by its path
    expect((await t.db.selectFrom("model_hashes").select("sha256").where("folder", "=", "loras").where("file", "=", "zz-test-dup.safetensors").executeTakeFirstOrThrow()).sha256).toBe(shaMine);
    // the other one's row asked by its path: that file moves, never the one ComfyUI loads
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-test-dup.safetensors", path: rowOf(l, other)!.path! }], to: "aside" }, fake);
    expect(done).toMatchObject({ moved: 1, left: [] });
    expect(readFileSync(mine)).toEqual(Buffer.alloc(500, 31));
    expect(existsSync(other)).toBe(false);
    await t.services.hashes.run();
    l = await lib();
    expect(rowOf(l, mine)).toMatchObject({ sha256: shaMine });
    const away = l.files.filter((f) => f.removed);
    expect(away.map((f) => [f.path, f.sha256])).toEqual([[other, shaOther]]);
    // put back where it was, with its own hash again, the name's still the other file's
    expect((await post(t.app, "/api/model-files/put-back", { ids: [away[0]!.removed!.id] })).json()).toMatchObject({ back: 1 });
    await t.services.hashes.run();
    l = await lib();
    expect(readFileSync(other)).toEqual(Buffer.alloc(500, 32));
    expect([rowOf(l, mine)?.sha256, rowOf(l, other)?.sha256]).toEqual([shaMine, shaOther]);
    // asked by its name alone (an older page): the file ComfyUI loads by it
    expect(await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-test-dup.safetensors" }], to: "aside" }, fake)).toMatchObject({ moved: 1 });
    expect([existsSync(mine), existsSync(other)]).toEqual([false, true]);
  });

  it("moves and says the file of the first directory holding a name, when two of a folder's directories hold it", async () => {
    // A1111's Lora holds a zz-test-same too, another file, also seen as a VAE (listed twice): the Delete of the first
    // directory's one said it gone from vae too, and left the other directory's file in place, as it should
    writeFileSync(join(home, "models", "loras", "zz-test-same.safetensors"), Buffer.alloc(100, 21));
    writeFileSync(join(home, "a1111", "models", "Lora", "zz-test-same.safetensors"), Buffer.alloc(100, 22));
    const base = `${home.replace(/\\/g, "/")}/a1111`;
    writeFileSync(join(home, "extra_model_paths.yaml"), ["a1111:", `  base_path: ${base}`, "  loras: models/Lora", "  vae: models/Lora", ""].join("\n"));
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-test-same.safetensors" }], to: "aside" }, fake);
    expect(done).toMatchObject({ moved: 1, also: [] });
    expect(existsSync(join(home, "models", "loras", "zz-test-same.safetensors"))).toBe(false);
    // the other directory's file stays: one row, its places those of A1111's Lora (loras, vae, the checkpoints junction)
    expect(existsSync(join(home, "a1111", "models", "Lora", "zz-test-same.safetensors"))).toBe(true);
    const left = live(await lib()).filter((f) => [f, ...f.also].some((p) => p.file.endsWith("zz-test-same.safetensors")));
    expect(left).toHaveLength(1);
    expect([left[0]!, ...left[0]!.also].map((p) => p.folder).sort()).toEqual(["checkpoints", "loras", "vae"]);
  });
});

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").toUpperCase();
/** Other bytes written over a file, of the same size, with another date: a v2 downloaded over its v1, not hashed yet. */
const replace = (path: string, size: number, fill: number) => {
  writeFileSync(path, Buffer.alloc(size, fill));
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
};
const hashOf = async (folder: string, file: string) => (await t.db.selectFrom("model_hashes").select("sha256").where("folder", "=", folder).where("file", "=", file).executeTakeFirst())?.sha256;

describe("a kept hash, only for the bytes it was read from (release review 0.9.0, D1)", () => {
  const copy = () => join(home, "models", "loras", "zz-test-copy.safetensors");

  it("a file replaced since it was hashed is no copy of its old bytes: Delete records no hash, Empty says the only copy, Put back has it hashed again", async () => {
    await t.services.hashes.run();
    expect(byFile(await lib(), "zz-test-copy.safetensors")!.copies).toEqual(["loras|style/zz-test-a.safetensors"]);
    replace(copy(), 300, 9);
    let l = await lib();
    expect(byFile(l, "zz-test-copy.safetensors")).toMatchObject({ sha256: null, copies: [] });
    expect(byFile(l, "style/zz-test-a.safetensors")!.copies).toEqual([]);
    const done = await deleteFiles(t.services, { files: [{ folder: "loras", file: "zz-test-copy.safetensors" }], to: "aside" }, fake);
    expect(done.moved).toBe(1);
    expect((await t.db.selectFrom("model_removed").select("sha256").executeTakeFirstOrThrow()).sha256).toBeNull();
    // Empty's list: the v2 away has no copy (the other file is v1's bytes), Empty would erase its only copy
    l = await lib();
    expect(l.files.filter((f) => f.removed).map((f) => f.copies)).toEqual([[]]);
    // the pass the Delete started forgets the name's row; put back, it is hashed as it is, never given v1's hash
    await t.services.hashes.run();
    expect((await post(t.app, "/api/model-files/put-back", { batch: done.batch })).json()).toMatchObject({ back: 1 });
    await t.services.hashes.run();
    await t.services.hashes.run();
    expect(await hashOf("loras", "zz-test-copy.safetensors")).toBe(sha(copy()));
  });

  it("Put back gives a file its hash again only while it is the bytes the Delete recorded it with", async () => {
    const vae = join(home, "models", "vae", "zz-test-vae.safetensors");
    await t.services.hashes.run();
    const was = sha(vae);
    const first = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    expect(await t.db.selectFrom("model_removed").select(["sha256", "mtime"]).executeTakeFirstOrThrow()).toEqual({ sha256: was, mtime: expect.any(Number) });
    await t.services.hashes.run();
    await post(t.app, "/api/model-files/put-back", { batch: first.batch });
    // the same bytes: its hash at once, nothing read again
    expect(await hashOf("vae", "zz-test-vae.safetensors")).toBe(was);
    await t.services.hashes.run();
    // away again, and changed there: listed with no hash, put back without one, hashed again as it is
    const second = await deleteFiles(t.services, { files: [{ folder: "vae", file: "zz-test-vae.safetensors" }], to: "aside" }, fake);
    await t.services.hashes.run();
    const stored = (await t.db.selectFrom("model_removed").select("stored_path").where("batch", "=", second.batch).executeTakeFirstOrThrow()).stored_path;
    replace(stored, 200, 4);
    expect((await lib()).files.find((f) => f.removed)!.sha256).toBeNull();
    expect((await post(t.app, "/api/model-files/put-back", { batch: second.batch })).json()).toMatchObject({ back: 1 });
    await t.services.hashes.run();
    await t.services.hashes.run();
    expect(await hashOf("vae", "zz-test-vae.safetensors")).toBe(sha(vae));
    expect(sha(vae)).not.toBe(was);
  });
});

describe("the file ComfyUI loads by a name (release review 0.9.0, D2)", () => {
  const X = "zz-test-x.safetensors";
  beforeEach(() => {
    for (const d of ["unet", "diffusion_models"]) mkdirSync(join(home, "models", d), { recursive: true });
  });

  it("is models/unet's when diffusion_models holds the name too: the other one is shadowed, the name's hash unet's", async () => {
    const unet = join(home, "models", "unet", X);
    const other = join(home, "models", "diffusion_models", X);
    writeFileSync(unet, Buffer.alloc(600, 41));
    writeFileSync(other, Buffer.alloc(600, 42));
    await t.services.hashes.run();
    const rows = (await lib()).files.filter((f) => !f.removed && f.file === X);
    expect(rows.map((f) => [f.id, f.path, f.sha256]).sort()).toEqual([[`diffusion_models|${X}`, unet, sha(unet)], [`diffusion_models|${X}|${other}`, other, sha(other)]].sort());
    expect(await hashOf("diffusion_models", X)).toBe(sha(unet));
    // asked by its name alone: the file ComfyUI loads, unet's
    expect(await deleteFiles(t.services, { files: [{ folder: "diffusion_models", file: X }], to: "aside" }, fake)).toMatchObject({ moved: 1 });
    expect([existsSync(unet), existsSync(other)]).toEqual([false, true]);
  });

  it("takes a link to a file as holding its name, and never moves the link", async () => {
    const target = join(home, "store", X);
    mkdirSync(join(home, "store"));
    writeFileSync(target, Buffer.alloc(700, 43));
    const link = join(home, "models", "unet", X);
    try {
      symlinkSync(target, link, "file");
    } catch {
      // Windows makes a link to a file only in Developer Mode or as an administrator
      return;
    }
    const other = join(home, "models", "diffusion_models", X);
    writeFileSync(other, Buffer.alloc(700, 44));
    await t.services.hashes.run();
    const rows = (await lib()).files.filter((f) => !f.removed && f.file === X);
    expect(rows.find((f) => f.path === link)).toMatchObject({ id: `diffusion_models|${X}`, size: 700, sha256: sha(target) });
    expect(rows.find((f) => f.path === other)).toMatchObject({ id: `diffusion_models|${X}|${other}` });
    const out = await deleteFiles(t.services, { files: [{ folder: "diffusion_models", file: X }], to: "aside" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: expect.stringContaining("is a link to") }] });
    expect([existsSync(link), existsSync(target), existsSync(other)]).toEqual([true, true, true]);
  });
});

describe("Delete's row, the file the user saw (release review 0.9.0, D8 D9)", () => {
  const vae = () => join(home, "models", "vae", "zz-test-vae.safetensors");
  const pending = (id: string, stored: string) => t.db.insertInto("model_removed").values({
    id, batch: "b", folder: "vae", file: "zz-test-vae.safetensors", path_was: vae(), size: 200, sha256: null, place: "bin", stored_path: stored, info_path: null,
    removed_at: now(), restored_at: null, emptied_at: null, pending: 1,
  }).execute();

  it("leaves a file that is not the one the list showed any more", async () => {
    const row = byFile(await lib(), "zz-test-vae.safetensors")!;
    replace(vae(), 200, 6);
    const out = await deleteFiles(t.services, { files: [{ folder: "vae", file: row.file, path: row.path!, size: row.size!, mtime: row.mtime! }], to: "aside" }, fake);
    expect(out).toMatchObject({ moved: 0, left: [{ why: expect.stringContaining("not the file the list showed") }] });
    expect(existsSync(vae())).toBe(true);
    const now2 = byFile(await lib(), "zz-test-vae.safetensors")!;
    expect(await deleteFiles(t.services, { files: [{ folder: "vae", file: now2.file, path: now2.path!, size: now2.size!, mtime: now2.mtime! }], to: "aside" }, fake)).toMatchObject({ moved: 1 });
  });

  it("undoes a move stopped between its link and its unlink: the file stays in its place, the name made for it goes", async () => {
    const stored = join(bin, "$RZZZZZZ.safetensors");
    linkSync(vae(), stored);
    await pending("half", stored);
    await settlePending(t.services);
    expect(existsSync(stored)).toBe(false);
    expect(readFileSync(vae())).toEqual(Buffer.alloc(200, 3));
    expect(await t.db.selectFrom("model_removed").selectAll().execute()).toEqual([]);
  });

  it("keeps as away a moved file whose place another file filled again (ComfyUI-Manager fetching it), Empty erasing it", async () => {
    const stored = join(bin, "$RZZZZZZ.safetensors");
    renameSync(vae(), stored);
    writeFileSync(vae(), Buffer.alloc(200, 5));
    await pending("moved", stored);
    await settlePending(t.services);
    expect(await t.db.selectFrom("model_removed").select(["id", "pending"]).execute()).toEqual([{ id: "moved", pending: 0 }]);
    expect((await lib()).files.filter((f) => f.removed).map((f) => f.removed!.id)).toEqual(["moved"]);
    expect((await post(t.app, "/api/model-files/empty", {})).json()).toEqual({ erased: 1, bytes: 200 });
    expect(readFileSync(vae())).toEqual(Buffer.alloc(200, 5));
  });
});
