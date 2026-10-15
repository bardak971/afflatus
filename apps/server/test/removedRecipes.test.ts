import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { recipeById } from "@afflatus/recipes";
import { now } from "../src/db";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Wan Animate 2, taken out of Afflatus in 0.5.0: what was made with it before still opens. A draft, a timeline with a clip
 * and a source of it, a finished job and a waiting one are read as they are; the waiting one fails saying it was removed.
 */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const GONE = "wananimate.motion";

describe("what was made with Wan Animate 2", () => {
  it("is no recipe or family any more", async () => {
    expect(recipeById(GONE)).toBeUndefined();
    const listed = (await get(t.app, "/api/recipes")).json();
    expect(listed.recipes.some((r: { id: string }) => r.id === GONE)).toBe(false);
    expect(listed.families.some((f: { id: string }) => f.id === "wananimate")).toBe(false);
  });

  it("opens: a draft, a timeline with a clip and a source of it, the history", async () => {
    const draft = (await post(t.app, "/api/drafts", { recipe: "scail.motion", name: "zz-test wan animate" })).json();
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test wan animate" })).json();
    const { clip } = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion" })).json();
    await t.db.updateTable("drafts").set({ recipe_id: GONE, forms: JSON.stringify({ [GONE]: { prompt: "zz-test" } }) }).where("id", "=", draft.id).execute();
    await t.db.updateTable("clips").set({ recipe_id: GONE }).where("id", "=", clip).execute();
    await t.db.updateTable("timelines").set({ source: JSON.stringify({ asset: "gone", atMs: 0, fromMs: 0, toMs: 6000, recipe: GONE, windowMs: 5000, inputs: {}, snap: false, clip: null }) }).where("id", "=", tl.id).execute();
    const at = now();
    await t.db.insertInto("jobs").values({ id: "zzwadone", owner_id: "local", recipe_id: GONE, label: "zz-test wan animate", inputs: "{}", status: "done", priority: 0, attempts: 0, created_at: at, updated_at: at, finished_at: at, clip_fit: 0, warm: 0 } as never).execute();

    expect((await get(t.app, `/api/drafts/${draft.id}`)).statusCode).toBe(200);
    expect((await get(t.app, "/api/drafts")).statusCode).toBe(200);
    const view = await get(t.app, `/api/timelines/${tl.id}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().clips[0].recipe).toBe(GONE);
    expect((await get(t.app, "/api/timelines")).statusCode).toBe(200);
    const history = await get(t.app, "/api/jobs?limit=10");
    expect(history.statusCode).toBe(200);
    expect(JSON.stringify(history.json())).toContain("zzwadone");
    expect((await get(t.app, "/api/queue")).statusCode).toBe(200);
  });

  it("left waiting, fails saying it was removed", async () => {
    const at = now();
    await t.db.insertInto("jobs").values({ id: "zzwawait", owner_id: "local", recipe_id: GONE, label: "zz-test wan animate", inputs: "{}", status: "queued", priority: 0, attempts: 0, created_at: at, updated_at: at, clip_fit: 0, warm: 0 } as never).execute();
    await t.services.queue.start();
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", "zzwawait").executeTakeFirst())?.status === "failed");
    const row = await t.db.selectFrom("jobs").select("error").where("id", "=", "zzwawait").executeTakeFirstOrThrow();
    expect(row.error).toBe("Wan Animate 2, removed from Afflatus");
  });
});
