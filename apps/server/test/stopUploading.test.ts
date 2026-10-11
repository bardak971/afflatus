import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT] } });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const statusOf = async (id: string) => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

describe("Stop while a render's files go up", () => {
  it("stops it there: ComfyUI's memory is not freed and the prompt is never sent", async () => {
    const bytes = await sharp({ create: { width: 832, height: 1216, channels: 3, background: { r: 90, g: 120, b: 150 } } }).png().toBuffer();
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "image/png" }, payload: bytes })).json() as { id: string };
    fake.uploadDelayMs = 800;
    const id = (await post(t.app, "/api/jobs", { recipe: "sdxl.redraw", input: { source: picture.id, prompt: "a harbour", checkpoint: CHECKPOINT } })).json().ids[0] as string;
    await until(() => fake.calls.includes("POST /upload/image"));
    expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    // said stopped at once, not once the upload has finished
    await until(async () => (await statusOf(id)) === "cancelled", 600);
    // past the time the upload would have taken: nothing more came of it
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(fake.calls).not.toContain("POST /free");
    expect(fake.calls).not.toContain("POST /prompt");
    expect(fake.prompts.size).toBe(0);
    expect(await statusOf(id)).toBe("cancelled");
  });
});
