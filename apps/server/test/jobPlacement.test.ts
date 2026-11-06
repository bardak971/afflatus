import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { CHECKPOINT, makeApp, post, referenceCatalog, type TestApp } from "./helpers";

/**
 * Where a job's results land (card #293): done again, a job keeps every one of its placement's fields (its draft, folder,
 * clip with its fit and flips, the take it finishes, the stack it renders versions of, its grid cell). A field lost on the
 * way would land a paid re-render somewhere else.
 */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const PLACEMENT = ["draft_id", "folder_id", "clip_id", "clip_fit", "clip_mirror", "finished_from", "version_of", "grid_id", "grid_cell"] as const;
const placement = async (id: string) => t.db.selectFrom("jobs").select(PLACEMENT).where("id", "=", id).executeTakeFirstOrThrow();

describe("a job done again", () => {
  it("lands where the job it repeats was to land, every field of its placement kept", async () => {
    const head = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20head", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json() as { id: string };
    const id = newId();
    const at = now();
    await t.db.insertInto("jobs").values({
      id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "zz-test placed", inputs: JSON.stringify({ prompt: "zz-test a lamp", checkpoint: CHECKPOINT }), asked: null,
      status: "failed", warm: 0, look: null, priority: 0, depends_on: null, attempts: 1, resume: null, error: "zz-test failed", generation_id: null,
      clip_id: "zz-clip", clip_fit: 1, clip_mirror: JSON.stringify(["image"]), timeline_id: null, finished_from: "zz-take",
      draft_id: "zz-draft", folder_id: "zz-folder", version_of: head.id, grid_id: "zz-grid", grid_cell: "1.2.0",
      created_at: at, started_at: at, finished_at: at, updated_at: at,
    }).execute();
    const res = await post(t.app, `/api/jobs/${id}/retry`, {});
    expect(res.statusCode, res.body).toBe(200);
    const redo = res.json().id as string;
    expect(redo).not.toBe(id);
    const was = await placement(id);
    // each field is set, so that none is equal by both being empty
    for (const k of PLACEMENT) expect(was[k], k).toBeTruthy();
    expect(await placement(redo)).toEqual(was);
  });
});
