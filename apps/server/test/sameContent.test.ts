import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { makePng } from "@afflatus/comfy/testing";
import { toneFile } from "./clipKit";
import { ffmpegThere } from "./framesKit";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const upload = (body: Uint8Array, type: string, query = "") =>
  t.app.inject({ method: "POST", url: `/api/assets?name=zz-test${query}`, headers: { "content-type": type }, payload: Buffer.from(body) });

const paste = (body: Uint8Array, type: string, query = "") => upload(body, type, `&same=use${query}`);
const digestOf = async (id: string) => (await t.db.selectFrom("assets").select("digest").where("id", "=", id).executeTakeFirstOrThrow()).digest;

describe("a file pasted that the library already holds", () => {
  it("is found by its pixels: the PNG the browser drew again for the clipboard is that picture, not a new one", async () => {
    const png = makePng(320, 200, [200, 80, 40], [20, 20, 60]);
    const first = (await paste(png, "image/png")).json();
    expect(first.found).toBeUndefined();
    // the same pixels in other bytes, as Copy the picture puts them on the clipboard
    const redrawn = new Uint8Array(await sharp(png).png({ compressionLevel: 1 }).toBuffer());
    expect(Buffer.from(redrawn).equals(Buffer.from(png))).toBe(false);
    const again = (await paste(redrawn, "image/png")).json();
    expect(again).toMatchObject({ id: first.id, found: true });
    expect((await get(t.app, "/api/assets")).json().items).toHaveLength(1);
  });

  it("is added as any upload when nothing holds it, or when it is not asked to be found", async () => {
    const png = makePng(320, 200, [200, 80, 40], [20, 20, 60]);
    await paste(png, "image/png");
    // the same size, other pixels: a new item
    const other = (await paste(makePng(320, 200, [1, 2, 3], [4, 5, 6]), "image/png")).json();
    expect(other.found).toBeUndefined();
    // a drop or From your computer does not ask: the same picture twice is two items, as before
    expect((await upload(png, "image/png")).json().found).toBeUndefined();
    expect((await get(t.app, "/api/assets")).json().items).toHaveLength(3);
  });

  it("does not decode a picture that is not asked to be found: a folder brought in works out no digest", async () => {
    const dropped = (await upload(makePng(64, 48, [10, 200, 10], [0, 0, 0]), "image/png")).json();
    expect(await digestOf(dropped.id)).toBeNull();
  });

  it("never reads older pictures again: one without a digest (a render, a drop) is not found, and a kept copy is added", async () => {
    const png = makePng(64, 48, [10, 200, 10], [0, 0, 0]);
    const old = (await upload(png, "image/png")).json();
    const made = (await paste(png, "image/png")).json();
    expect(made.found).toBeUndefined();
    expect(made.id).not.toBe(old.id);
    expect(await digestOf(old.id)).toBeNull();
  });

  it("is never an item not kept: a render that would go to the bin takes no paste with it, a kept copy is added", async () => {
    const png = makePng(64, 48, [30, 60, 90], [0, 0, 0]);
    const render = (await paste(png, "image/png")).json();
    await t.db.updateTable("assets").set({ kept_at: null, origin: "generated" }).where("id", "=", render.id).execute();
    const made = (await paste(png, "image/png")).json();
    expect(made.found).toBeUndefined();
    expect(made.id).not.toBe(render.id);
    expect(made.kept).toBe(true);
  });

  it("is never an item in another folder or another project: the paste lands where it was pasted", async () => {
    const png = makePng(64, 48, [90, 60, 30], [0, 0, 0]);
    const p = (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "zz-test paste" } })).json();
    const refs = (await t.app.inject({ method: "POST", url: "/api/folders", payload: { name: "zz-test Refs", parentId: p.folderId } })).json();
    const loose = (await paste(png, "image/png")).json();
    const inRefs = (await paste(png, "image/png", `&project=${p.id}&folder=${refs.id}`)).json();
    expect(inRefs.found).toBeUndefined();
    expect(inRefs).toMatchObject({ folderId: refs.id });
    expect(inRefs.id).not.toBe(loose.id);
    // in the project's root: not the one in Refs either
    const atRoot = (await paste(png, "image/png", `&project=${p.id}`)).json();
    expect(atRoot.found).toBeUndefined();
    expect(atRoot.folderId).toBe(p.folderId);
    // pasted into Refs again: the one already there
    expect((await paste(png, "image/png", `&project=${p.id}&folder=${refs.id}`)).json()).toMatchObject({ id: inRefs.id, found: true });
  });

  it("never answers with an item in the bin, or one that is not in the library (a Prompt kit's picture)", async () => {
    const png = makePng(64, 64, [9, 9, 9], [200, 200, 200]);
    const binned = (await paste(png, "image/png")).json();
    await t.db.updateTable("assets").set({ deleted_at: new Date().toISOString() }).where("id", "=", binned.id).execute();
    await upload(png, "image/png", "&as=kit");
    const made = (await paste(png, "image/png")).json();
    expect(made.found).toBeUndefined();
    expect(made.id).not.toBe(binned.id);
  });

  it.skipIf(!ffmpegThere)("finds a sound by its bytes, one made before digests too (only a file of its exact size is read)", async () => {
    const tone = await toneFile(1);
    const first = (await upload(tone, "audio/wav")).json();
    expect(await digestOf(first.id)).toBeNull();
    expect((await paste(tone, "audio/wav")).json()).toMatchObject({ id: first.id, found: true });
    expect(await digestOf(first.id)).toMatch(/^file:/);
    expect((await get(t.app, "/api/assets?kind=audio")).json().items).toHaveLength(1);
  });
});
