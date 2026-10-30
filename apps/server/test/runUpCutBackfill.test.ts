import { describe, expect, it } from "vitest";
import type { Measure } from "../src/measure";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { timelineSteps, timelineSuite } from "./timelineKit";

const s = timelineSuite();
const steps = timelineSteps(s);

// card #161: a take that carries on is looked at for a cut after its run-up when it lands, and the takes kept from before
// that are looked at in the background, the finding kept with their render's measure where the timeline reads it
describe.skipIf(!ffmpegThere)("a cut after the run-up, measured and backfilled", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is measured as a continuation lands, and measured once for one kept before", async () => {
    const { b } = await steps.twoClips();
    const take = await s.t.db.selectFrom("clips").innerJoin("takes", "takes.id", "clips.take_id").innerJoin("assets", "assets.id", "takes.asset_id").select(["takes.asset_id as asset", "takes.head_ms as head", "assets.generation_id as generation"]).where("clips.id", "=", b).executeTakeFirstOrThrow();
    expect(take.head).toBeGreaterThan(0);
    const measure = async () => JSON.parse((await s.t.db.selectFrom("generations").select("measure").where("id", "=", take.generation!).executeTakeFirstOrThrow()).measure!) as Measure;
    // measured just after it is filed
    for (let i = 0; i < 200 && !(await s.t.db.selectFrom("generations").select("measure").where("id", "=", take.generation!).executeTakeFirstOrThrow()).measure; i++) await new Promise((r) => setTimeout(r, 100));
    // the pattern clip carries on: looked at, nothing found
    expect((await measure()).runUpCut).toBeNull();
    // a take measured before: the figure missing, then found and kept beside the others, once
    const { runUpCut: _, ...before } = await measure();
    await s.t.db.updateTable("generations").set({ measure: JSON.stringify(before) }).where("id", "=", take.generation!).execute();
    const media = s.t.services.timelines.media;
    expect(await media.runUpCut(take.asset)).toBe(true);
    expect(await measure()).toEqual({ ...before, runUpCut: null });
    expect(await media.runUpCut(take.asset)).toBe(false);
    // the first clip, which carries on from nothing, has nothing to look at
    const first = await s.t.db.selectFrom("takes").select("asset_id").where("head_ms", "=", 0).executeTakeFirstOrThrow();
    expect(await media.runUpCut(first.asset_id)).toBe(false);
  });
});
