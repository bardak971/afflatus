import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { fillKeptBytes } from "../src/media";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * What an item keeps on the disk beside its file (an H3 clip's latents, the model's own frames) is in every size shown:
 * the projects tree, the storage card and the item itself. An H3 clip shown at 4 MB took 15 to 20 (2026-10-15).
 */
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

/** An H3 clip made before kept_bytes: a 100-byte video, a 1000-byte latent and a 300-byte raw beside it. */
async function oldClip(): Promise<string> {
  const id = newId();
  const at = (ext: string) => `assets/${id.slice(0, 2)}/${id}.${ext}`;
  await t.services.storage.put(at("mp4"), new Uint8Array(100));
  await t.services.storage.put(at("latent.safetensors"), new Uint8Array(1000));
  await t.services.storage.put(at("raw.mp4"), new Uint8Array(300));
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "video", origin: "generated", name: "zz-test clip", file_key: at("mp4"), thumb_key: null, mime: "video/mp4",
    bytes: 100, width: 64, height: 64, duration_ms: 1000, fps: 24, has_sound: 0, folder_id: null, generation_id: null,
    raw_key: at("raw.mp4"), latent_key: at("latent.safetensors"), latent_frames: 3, kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
  }).execute();
  return id;
}

describe("the space an item takes", () => {
  it("counts its latent and raw files, once read at start, in the tree, the storage card and the item", async () => {
    const id = await oldClip();
    expect((await t.db.selectFrom("assets").select("kept_bytes").where("id", "=", id).executeTakeFirstOrThrow()).kept_bytes).toBe(0);
    expect(await fillKeptBytes(t.db, t.services.storage)).toBe(1);
    // read once: nothing left to fill
    expect(await fillKeptBytes(t.db, t.services.storage)).toBe(0);

    const tree = (await get(t.app, "/api/projects/tree")).json() as { totalBytes: number; groups: Array<{ name: string; bytes: number }> };
    expect(tree.totalBytes).toBe(1400);
    expect(tree.groups.find((g) => g.name === "Inbox")!.bytes).toBe(1400);
    const storage = (await get(t.app, "/api/storage")).json() as { videos: number };
    expect(storage.videos).toBe(1400);
    const item = (await get(t.app, `/api/assets/${id}`)).json() as { bytes: number; keptBytes: number };
    // the file's own size stays its own: what the browser is sent, and a file's version
    expect(item).toMatchObject({ bytes: 100, keptBytes: 1300 });
  });
});
