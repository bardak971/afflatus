import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { colourMatchedChain } from "../src/queueSubmit";
import { makeApp, type TestApp } from "./helpers";

/** Whether an H3 chain was colour-matched to its first frame, read back through its renders: its clips after carry the match on. */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** A rendered video, its render's form as given, optionally a finish of another video. */
async function rendered(inputs: Record<string, unknown> | null, source: string | null = null): Promise<string> {
  const id = newId();
  let generation: string | null = null;
  if (inputs) {
    generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: JSON.stringify(inputs), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() }).execute();
  }
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: "generated", name: "v.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 48, has_sound: 1, folder_id: null, generation_id: generation, source_id: source, kept_at: now(),
  })).execute();
  return id;
}

describe("a chain colour-matched to its first frame", () => {
  it("is known at its first clip and at every clip that carries on from it, a finish standing for its draft", async () => {
    const first = await rendered({ description: "a", start: "p1", colourMatch: true });
    const second = await rendered({ description: "b", previous: { asset: first, at: 5146 } });
    const third = await rendered({ description: "c", previous: { asset: second, at: 5854 } });
    const finished = await rendered(null, second);
    expect(await colourMatchedChain(t.db, first)).toBe(true);
    expect(await colourMatchedChain(t.db, second)).toBe(true);
    expect(await colourMatchedChain(t.db, third)).toBe(true);
    expect(await colourMatchedChain(t.db, finished)).toBe(true);
  });

  it("is not one whose first clip was left in the model's colours, nor a video not rendered here", async () => {
    const plain = await rendered({ description: "a", start: "p1", colourMatch: false });
    expect(await colourMatchedChain(t.db, await rendered({ description: "b", previous: { asset: plain, at: 5146 } }))).toBe(false);
    expect(await colourMatchedChain(t.db, await rendered(null))).toBe(false);
    expect(await colourMatchedChain(t.db, "not-there")).toBe(false);
  });
});
