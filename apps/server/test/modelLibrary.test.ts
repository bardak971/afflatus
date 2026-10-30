import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
