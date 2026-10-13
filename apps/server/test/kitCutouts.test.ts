import { afterEach, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { REMOVE_BACKGROUND } from "@afflatus/core";
import { h3Video } from "@afflatus/recipes";
import { compose } from "../src/entities";
import { askCutouts, askEveryCutout } from "../src/kitCutouts";
import { get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

/** An app whose pretend ComfyUI has the background remover's model, or not. */
async function start(remover: boolean) {
  const catalog = referenceCatalog();
  // what ComfyUI's loader offers is its own list (object_info), as the upscalers' are in the other tests
  catalog.LoadBackgroundRemovalModel!.input.required!.bg_removal_name = [remover ? ["birefnet.safetensors"] : []];
  fake = await startFakeComfy({
    catalog,
    models: { background_removal: remover ? ["birefnet.safetensors"] : [], diffusion_models: ["minimax_h3_fl2va.safetensors", "minimax_h3_ref2va.safetensors"] },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
}

const put = async (url: string, payload: unknown) => (await t.app.inject({ method: "PUT", url, payload: payload as object })).json();
const picture = async (name: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}&as=kit`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id as string;
const person = async (id: string) => JSON.parse((await t.db.selectFrom("entities").select("def").where("id", "=", id).executeTakeFirstOrThrow()).def) as { pictures: string[]; cutout: boolean; cutouts: Record<string, string> };
/**
 * Every prompt ComfyUI was sent, answered as the background remover does: a picture whose background is see-through
 * (its colour under the transparency still the room's red, as ComfyUI keeps it).
 */
let cutPng: Buffer | null = null;
function answer() {
  for (const id of fake.pending) {
    const graph = fake.prompts.get(id)!;
    const out = Object.entries(graph).find(([, n]) => n.class_type === "PreviewImage")![0];
    fake.files[`${id}.png`] = cutPng!;
    fake.pending = fake.pending.filter((p) => p !== id);
    fake.history[id] = { status: { completed: true }, outputs: { [out]: { images: [{ filename: `${id}.png`, subfolder: "", type: "temp" }] } } };
  }
}
beforeAll(async () => {
  cutPng = await sharp({ create: { width: 64, height: 96, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 0 } } }).png().toBuffer();
});
const cutoutJobs = () => t.db.selectFrom("jobs").select(["status", "kit_for", "label"]).where("recipe_id", "=", REMOVE_BACKGROUND).execute();

describe("a person's pictures without their background", () => {
  it("are cut out once each when the person is saved, filed with them out of the library, and sent in place of the pictures", async () => {
    await start(true);
    const [front, side] = [await picture("front.png"), await picture("side.png")];
    const nico = (await post(t.app, "/api/entities", { kind: "person", name: "Nico" })).json();
    await put(`/api/entities/${nico.id}`, { def: { pictures: [front, side], cutout: true } });
    // two jobs, one per picture, named for the queue
    await until(async () => (await cutoutJobs()).length === 2);
    expect((await cutoutJobs()).map((j) => j.label)).toEqual(["Cut-out · Nico", "Cut-out · Nico"]);
    await until(async () => (answer(), Object.keys((await person(nico.id)).cutouts).length === 2), 20_000);
    const p = await person(nico.id);
    const cut = p.cutouts[front]!;
    // a kit file: kept, in no folder, made from the picture, not in the library
    const row = await t.db.selectFrom("assets").selectAll().where("id", "=", cut).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ origin: "kit", folder_id: null, source_id: front, mime: "image/png", name: "Nico · cut-out", deleted_at: null });
    expect(row.kept_at).not.toBeNull();
    // laid on grey: ComfyUI's loader would drop the transparency and bring the red room back
    const pixel = await sharp(await t.services.storage.get(row.file_key)).raw().toBuffer({ resolveWithObject: true });
    expect([...pixel.data.subarray(0, 3)]).toEqual([128, 128, 128]);
    expect(pixel.info.channels).toBe(3);
    const library = (await get(t.app, "/api/assets")).json();
    expect(JSON.stringify(library)).not.toContain(cut);
    // sent in place of the pictures, said so
    const composed = await compose(t.db, h3Video, { description: "a" }, { cast: [{ id: nico.id }], snippets: [] });
    expect(composed.input.references).toEqual([{ asset: p.cutouts[front], role: "person" }, { asset: p.cutouts[side], role: "person" }]);
    expect(composed.added.refs.map((r) => r.cutout)).toEqual([true, true]);
    // asked again (another save, a render): nothing more is queued
    expect(await askCutouts(t.services, [nico.id])).toBe(0);
  });

  it("keep their cut-outs through a save from the page, and drop a picture's cut-out with the picture", async () => {
    await start(true);
    const [front, side] = [await picture("front.png"), await picture("side.png")];
    const nico = (await post(t.app, "/api/entities", { kind: "person", name: "Nico" })).json();
    await put(`/api/entities/${nico.id}`, { def: { pictures: [front, side], cutout: true } });
    await until(async () => (answer(), Object.keys((await person(nico.id)).cutouts).length === 2), 20_000);
    const before = (await person(nico.id)).cutouts;
    // the page's copy, older than the cut-outs: they are kept all the same
    await put(`/api/entities/${nico.id}`, { def: { pictures: [front, side], cutouts: {} } });
    expect((await person(nico.id)).cutouts).toEqual(before);
    // the side picture taken off: its cut-out goes to the bin with it
    await put(`/api/entities/${nico.id}`, { def: { pictures: [front] } });
    expect((await person(nico.id)).cutouts).toEqual({ [front]: before[front] });
    const gone = await t.db.selectFrom("assets").select("deleted_at").where("id", "=", before[side]!).executeTakeFirstOrThrow();
    expect(gone.deleted_at).not.toBeNull();
  });

  it("are sent as they are with the switch off, and none is asked for", async () => {
    await start(true);
    const front = await picture("front.png");
    const nico = (await post(t.app, "/api/entities", { kind: "person", name: "Nico", def: { pictures: [front], cutout: false } })).json();
    expect(await askCutouts(t.services, [nico.id])).toBe(0);
    expect(await cutoutJobs()).toEqual([]);
    const composed = await compose(t.db, h3Video, { description: "a" }, { cast: [{ id: nico.id }], snippets: [] });
    expect(composed.input.references).toEqual([{ asset: front, role: "person" }]);
    expect(composed.added.refs[0]!.cutout).toBeUndefined();
  });

  it("are asked for at start for the people kept before there were cut-outs, once", async () => {
    await start(true);
    const front = await picture("front.png");
    // kept by an older Afflatus, without a switch: off, nothing asked
    const at = new Date().toISOString();
    await t.db.insertInto("entities").values({ id: "older", owner_id: "local", kind: "person", name: "Older Nico", def: JSON.stringify({ pictures: [front], voice: null, tags: "", sentence: "", models: {}, outfits: [] }), created_at: at, updated_at: at }).execute();
    expect(await askEveryCutout(t.services)).toBe(0);
    // switched on, with no cut-outs and nothing asked when it was saved
    await t.db.insertInto("entities").values({ id: "old", owner_id: "local", kind: "person", name: "Old Nico", def: JSON.stringify({ pictures: [front], voice: null, tags: "", sentence: "", models: {}, outfits: [], cutout: true }), created_at: at, updated_at: at }).execute();
    expect(await askEveryCutout(t.services)).toBe(1);
    expect((await cutoutJobs()).map((j) => j.label)).toEqual(["Cut-out · Old Nico"]);
    // the next start, while it is still on its way: nothing more
    expect(await askEveryCutout(t.services)).toBe(0);
    await until(async () => (answer(), Object.keys((await person("old")).cutouts ?? {}).length === 1), 20_000);
  });

  it("are not asked for when no ComfyUI can remove a background: the pictures go as they are", async () => {
    await start(false);
    const front = await picture("front.png");
    const nico = (await post(t.app, "/api/entities", { kind: "person", name: "Nico", def: { pictures: [front], cutout: true } })).json();
    expect(await askCutouts(t.services, [nico.id])).toBe(0);
    expect(await cutoutJobs()).toEqual([]);
  });
});
