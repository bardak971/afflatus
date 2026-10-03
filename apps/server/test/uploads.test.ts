import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { sweep } from "../src/sweep";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const upload = (body: Uint8Array | string, type = "image/png", name = "") =>
  t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}`, headers: { "content-type": type }, payload: Buffer.from(body) });

describe("adding a picture from the computer", () => {
  it("files it in the library, kept, with its size and a thumbnail", async () => {
    const res = await upload(makePng(640, 360, [200, 80, 40], [20, 20, 60]), "image/png", "holiday.png");
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a).toMatchObject({ kind: "image", origin: "uploaded", name: "holiday.png", mime: "image/png", width: 640, height: 360, kept: true, generationId: null });

    const list = (await get(t.app, "/api/assets")).json();
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await get(t.app, `/api/assets/${a.id}/file`)).headers["content-type"]).toBe("image/png");
    expect((await get(t.app, `/api/assets/${a.id}/thumb`)).headers["content-type"]).toBe("image/webp");
  });

  it("is never binned on its own: it was not made here, it was brought in", async () => {
    const a = (await upload(makePng(64, 64, [0, 0, 0], [255, 255, 255]))).json();
    await sweep(t.db, t.services.storage, Date.now() + 30 * 24 * 3600 * 1000);
    expect((await get(t.app, `/api/assets/${a.id}`)).json()).toMatchObject({ inBin: false });
  });

  it("goes by what the file is, not by what it is called", async () => {
    // a PNG sent as a JPEG is stored as the PNG it is
    const a = (await upload(makePng(32, 48, [9, 9, 9], [9, 9, 9]), "image/jpeg")).json();
    expect(a).toMatchObject({ mime: "image/png", width: 32, height: 48 });
  });

  it("refuses what is not a picture, and says what works", async () => {
    const res = await upload("not a picture at all", "image/png");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/PNG, JPEG, WebP/);
    expect((await get(t.app, "/api/assets")).json().items).toEqual([]);
  });
});
