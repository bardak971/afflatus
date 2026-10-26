import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import type { ClipRow } from "../src/timelineModel";
import { makeApp, type TestApp } from "./helpers";

/**
 * Card #108: a timeline tells each LTX clip whether the clip after carries on in its latent (`latentAfter`), so that the
 * clip before a join in the latent is doubled with RIFE too, as the clip after it is (a whole chain in the latent takes
 * RIFE). Clips put in the database by hand; nothing is rendered or measured (a quick plan, no takes yet).
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function clip(timeline: string, position: number, over: Partial<ClipRow> = {}): Promise<string> {
  const id = newId();
  const at = now();
  await t.db.insertInto("clips").values({
    id, timeline_id: timeline, position, take_id: null, joined: "continue", recipe_id: "ltx25.video", inputs: "{}", kind: "video", still_asset_id: null, still_ms: 3000,
    sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: at, updated_at: at, ...over,
  }).execute();
  return id;
}

describe("the clip after carrying on in a clip's latent", () => {
  it("is said on every LTX clip: true before a clip of the same version that carries on, false otherwise", async () => {
    const tl = (await t.services.timelines.create("zz-test latent chain")).id;
    const ids = [
      await clip(tl, 0, { joined: "cut" }),
      await clip(tl, 1),
      // 2.5 Lip sync carries on in a 2.5 Video with audio's latent
      await clip(tl, 2, { recipe_id: "ltx25.lipsync" }),
      // 2.3 after 2.5: a cut in the latent (another version's), joined on frames
      await clip(tl, 3, { recipe_id: "ltx.video" }),
      // after a cut: nothing carries on from the clip before it
      await clip(tl, 4, { recipe_id: "ltx.video", joined: "cut" }),
      // H3 after LTX: H3 keeps a latent of its own, never LTX's
      await clip(tl, 5, { recipe_id: "h3.video" }),
    ];
    const planOf = async (k: number) => {
      const row = await t.db.selectFrom("clips").select("recipe_id").where("id", "=", ids[k]!).executeTakeFirstOrThrow();
      const recipe = t.services.registry.recipe(row.recipe_id!)!;
      // a form saved with it on (a take's settings used again) is said anew
      return (await t.services.timelines.plan(ids[k]!, recipe, { prompt: "zz-test", latentAfter: true }, false, null, true)).input;
    };
    expect((await planOf(0)).latentAfter).toBe(true);
    expect((await planOf(1)).latentAfter).toBe(true);
    expect((await planOf(2)).latentAfter).toBe(false);
    expect((await planOf(3)).latentAfter).toBe(false);
    expect((await planOf(4)).latentAfter).toBe(false);
    // H3 has no such toggle: nothing added to its inputs
    expect((await planOf(5)).latentAfter).toBe(undefined);
  });

  it("a last clip, and one before a still, carry nothing on", async () => {
    const tl = (await t.services.timelines.create("zz-test latent chain end")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    await clip(tl, 1, { kind: "still", recipe_id: null });
    const b = await clip(tl, 2, { joined: "cut" });
    const recipe = t.services.registry.recipe("ltx25.video")!;
    expect((await t.services.timelines.plan(a, recipe, { prompt: "zz-test" }, false, null, true)).input.latentAfter).toBe(false);
    expect((await t.services.timelines.plan(b, recipe, { prompt: "zz-test" }, false, null, true)).input.latentAfter).toBe(false);
  });
});
