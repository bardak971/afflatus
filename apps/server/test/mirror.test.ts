import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { makeApp, type TestApp } from "./helpers";

/** Mirroring a picture: a new picture beside it, kept, its source remembered, its pixels swapped as asked. */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** A 4 × 2 picture: red on the left half, green on the right, the bottom-right pixel blue. */
async function picture(): Promise<Buffer> {
  const px = Buffer.alloc(4 * 2 * 3);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 3;
      const [r, g, b] = x === 3 && y === 1 ? [0, 0, 255] : x < 2 ? [255, 0, 0] : [0, 255, 0];
      px[i] = r!;
      px[i + 1] = g!;
      px[i + 2] = b!;
    }
  }
  return sharp(px, { raw: { width: 4, height: 2, channels: 3 } }).png().toBuffer();
}

/** The colour at a point of a picture in the library, as [r, g, b]. */
async function colourAt(id: string, x: number, y: number): Promise<number[]> {
  const file = await t.app.inject({ method: "GET", url: `/api/assets/${id}/file` });
  const { data, info } = await sharp(file.rawPayload).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

describe("mirroring a picture", () => {
  it("makes a kept copy beside it, left and right or top and bottom swapped, with its source", async () => {
    const up = (await t.app.inject({ method: "POST", url: "/api/assets?name=rider", headers: { "content-type": "image/png" }, payload: await picture() })).json() as { id: string };
    const across = await t.app.inject({ method: "POST", url: `/api/assets/${up.id}/mirror`, payload: { axis: "horizontal" } });
    expect(across.statusCode).toBe(200);
    const a = across.json() as { id: string; name: string; kept: boolean; width: number; height: number; origin: string };
    expect(a).toMatchObject({ name: "rider, mirrored", kept: true, width: 4, height: 2, origin: "edited" });
    expect(await colourAt(a.id, 0, 0)).toEqual([0, 255, 0]);
    expect(await colourAt(a.id, 0, 1)).toEqual([0, 0, 255]);
    expect(await colourAt(a.id, 3, 0)).toEqual([255, 0, 0]);
    const down = (await t.app.inject({ method: "POST", url: `/api/assets/${up.id}/mirror`, payload: { axis: "vertical" } })).json() as { id: string };
    expect(await colourAt(down.id, 3, 0)).toEqual([0, 0, 255]);
    expect(await colourAt(down.id, 0, 0)).toEqual([255, 0, 0]);
    const detail = (await t.app.inject({ method: "GET", url: `/api/assets/${a.id}` })).json() as { source?: { asset: { id: string } } };
    expect(detail.source?.asset.id).toBe(up.id);
    // the original is untouched
    expect(await colourAt(up.id, 0, 0)).toEqual([255, 0, 0]);
  });

  it("refuses what is not a picture, and an axis it does not know", async () => {
    const up = (await t.app.inject({ method: "POST", url: "/api/assets?name=rider", headers: { "content-type": "image/png" }, payload: await picture() })).json() as { id: string };
    expect((await t.app.inject({ method: "POST", url: `/api/assets/${up.id}/mirror`, payload: { axis: "diagonal" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: "/api/assets/nothing/mirror", payload: { axis: "horizontal" } })).statusCode).toBe(404);
  });
});
