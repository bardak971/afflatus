import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { get, makeApp, type TestApp } from "./helpers";
import { ERASED, eraseAsset } from "../src/sweep";
import { readPicture, smallThumbKey, thumbKey } from "../src/thumbs";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const ID = "0123456789abcdef0123456789abcdef";
const has = (key: string) => t.services.storage.size(key).then(() => true, () => false);

/** A picture in the library, stored with no thumbnail yet: the route makes it on first ask. */
async function picture(width: number, height: number) {
  await t.services.storage.put(`assets/${ID}.png`, makePng(width, height, [120, 60, 40], [40, 80, 120]));
  await t.db
    .insertInto("assets")
    .values({
      id: ID, owner_id: "local", kind: "image", origin: "uploaded", name: "zz-test picture", file_key: `assets/${ID}.png`, thumb_key: null, mime: "image/png",
      bytes: 1, width, height, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
      kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
    })
    .execute();
}

describe("the small thumbnail", () => {
  it("is 256 px, made from the 512 one on first ask and kept beside it; any other width gets the 512 one", async () => {
    await picture(832, 1216);
    const big = await get(t.app, `/api/assets/${ID}/thumb`);
    expect(big.headers["content-type"]).toBe("image/webp");
    expect(await readPicture(big.rawPayload)).toMatchObject({ width: 350, height: 512 });
    expect(await has(smallThumbKey(ID))).toBe(false);

    const small = await get(t.app, `/api/assets/${ID}/thumb?w=256`);
    expect(small.headers["content-type"]).toBe("image/webp");
    expect(small.headers["cache-control"]).toMatch(/immutable/);
    expect(await readPicture(small.rawPayload)).toMatchObject({ width: 175, height: 256 });
    expect(small.rawPayload.length).toBeLessThan(big.rawPayload.length);
    expect(await has(smallThumbKey(ID))).toBe(true);
    // asked again: the kept one, the same bytes
    expect((await get(t.app, `/api/assets/${ID}/thumb?w=256`)).rawPayload).toEqual(small.rawPayload);
    expect((await get(t.app, `/api/assets/${ID}/thumb?w=999`)).rawPayload).toEqual(big.rawPayload);
    expect((await get(t.app, `/api/assets/${ID}/thumb?w=nope`)).rawPayload).toEqual(big.rawPayload);
  });

  it("is made again when the 512 one is (the file changed on the disk), never left of the old picture", async () => {
    await picture(832, 1216);
    await get(t.app, `/api/assets/${ID}/thumb?w=256`);
    // what a linked folder's reading does when the file was written again: the thumbnail dropped, made again on next ask
    await t.services.storage.put(`assets/${ID}.png`, makePng(1216, 832, [10, 200, 40], [40, 80, 120]));
    await t.services.storage.delete(thumbKey(ID));
    await t.db.updateTable("assets").set({ thumb_key: null }).where("id", "=", ID).execute();
    expect(await readPicture((await get(t.app, `/api/assets/${ID}/thumb`)).rawPayload)).toMatchObject({ width: 512, height: 350 });
    expect(await readPicture((await get(t.app, `/api/assets/${ID}/thumb?w=256`)).rawPayload)).toMatchObject({ width: 256, height: 175 });
  });

  it("goes with its item when the item is erased", async () => {
    await picture(640, 640);
    await get(t.app, `/api/assets/${ID}/thumb?w=256`);
    expect(await has(smallThumbKey(ID))).toBe(true);
    const row = await t.db.selectFrom("assets").select(ERASED).where("id", "=", ID).executeTakeFirstOrThrow();
    await eraseAsset(t.db, t.services.storage, row);
    expect(await has(smallThumbKey(ID))).toBe(false);
    expect(await has(thumbKey(ID))).toBe(false);
  });
});
