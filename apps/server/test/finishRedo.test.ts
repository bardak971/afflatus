import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { CUT_JOB } from "../src/timelineModel";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * Finish › Redo finished › Changed: a clip finished with the settings asked is left as it is. Compared on the job the finish
 * would queue, as the done one is read: SCAIL-2's Face refine takes its form's own denoise (0.35), not the dialog's (H3's
 * 0.45), so a redo with the dialog as it was is no change. Rows put in by hand: nothing is rendered.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** A video of the library, rendered here with this form (its generation) when one is given. */
async function video(inputs: Record<string, unknown> | null): Promise<string> {
  const id = newId();
  let generation: string | null = null;
  if (inputs) {
    generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "scail.motion24", recipe_version: 1, family: "scail", inputs: JSON.stringify(inputs), resolved: JSON.stringify({ seed: 7 }), gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
  }
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: inputs ? "generated" : "cut", name: "zz-test dance.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 192, height: 320, duration_ms: 3000, fps: 24, has_sound: 1, folder_id: null, generation_id: generation, kept_at: now(),
  })).execute();
  return id;
}

async function take(clip: string, asset: string, finishedFrom: string | null): Promise<string> {
  const id = newId();
  await t.db.insertInto("takes").values({ id, clip_id: clip, asset_id: asset, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: finishedFrom, created_at: now() }).execute();
  await t.db.updateTable("clips").set({ take_id: id }).where("id", "=", clip).execute();
  return id;
}

describe("Redo finished › Changed", () => {
  it("leaves a SCAIL-2 clip whose Face refine was made at its form's denoise, whatever the dialog's", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test redo changed" } })).json();
    const clip = (await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/clips`, payload: { recipe: "scail.motion24" } })).json().clip as string;
    const draft = await take(clip, await video({ prompt: "zz-test" }), null);
    await take(clip, await video(null), draft);
    // the finish that made it, done after the clip last changed: the cut a Face refine on SCAIL-2 queues, at 0.35
    const at = new Date(Date.now() + 1000).toISOString();
    await t.db.insertInto("jobs").values({
      id: newId(), owner_id: OWNER, recipe_id: CUT_JOB, label: "zz-test finish", status: "done", priority: 0, clip_id: clip, created_at: at, updated_at: at, finished_at: at,
      inputs: JSON.stringify({ asset: "x", startMs: 0, endMs: 3000, action: "finish", route: "face", by: 1, faceDenoise: 0.35, family: "scail", clip, finishedFrom: draft }),
    } as never).execute();
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/finish`, payload: { route: "face", factor: 2, faceDenoise: 0.45, redo: "changed" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(res.json().skipped).toEqual([{ clip: 1, why: "finished already with these settings" }]);
    // the view still says what plays
    expect((await get(t.app, `/api/timelines/${tl.id}`)).json().clips[0].take.finishedFrom).toBe(draft);
  });
});

describe("a Face refine with a finish queued behind it (Face refine first, then an upscale)", () => {
  it("is placed among the clip's takes but does not play, nor take a step: the finish made from it is the finished take", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test face first" } })).json();
    const clip = (await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/clips`, payload: { recipe: "scail.motion24" } })).json().clip as string;
    const draft = await take(clip, await video({ prompt: "zz-test" }), null);
    const before = (await get(t.app, `/api/timelines/${tl.id}`)).json().undo;
    const refined = await video({ prompt: "zz-test", faceRefineOnly: true });
    const generation = (await t.db.selectFrom("assets").select("generation_id").where("id", "=", refined).executeTakeFirstOrThrow()).generation_id!;
    await t.services.timelines.finished(clip, generation, undefined, {}, draft, true);
    const v = (await get(t.app, `/api/timelines/${tl.id}`)).json();
    expect(v.clips[0].take.id).toBe(draft);
    expect(v.clips[0].takes.map((x: { asset: { id: string } }) => x.asset.id)).toContain(refined);
    expect(v.undo).toBe(before);
  });
});
