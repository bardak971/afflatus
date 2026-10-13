import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, makeFake, post, type TestApp } from "./helpers";

/** A timeline's clips sent to one ComfyUI (New take's machine slice): each job pinned there. */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  // paused: the job stays waiting, to be read as it was queued
  await post(t.app, "/api/queue/pause", {});
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("a timeline's clips sent to a machine", () => {
  it("are queued pinned to it, and one there is not is refused", async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test Evening" })).json();
    const clip = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip as string;
    const res = await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { description: "She walks to the window." } }], machine: "m1" });
    expect(res.statusCode).toBe(200);
    const job = await t.db.selectFrom("jobs").select(["pin_machine", "clip_id"]).where("id", "=", res.json().ids[0]).executeTakeFirstOrThrow();
    expect(job).toEqual({ pin_machine: "m1", clip_id: clip });
    expect((await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { description: "x" } }], machine: "m9" })).statusCode).toBe(400);
  });
});
