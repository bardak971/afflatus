import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { complete, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * What the queue asks a ComfyUI between two prompts: on a pod each request is a round trip with its GPU idle (a picture
 * batch's whole gap). Its socket has just said the render before ended and its queue is empty: it is not asked again whether
 * it answers, nor whose its empty queue's prompts are.
 */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("between two prompts on one ComfyUI", () => {
  it("asks no status once its socket said the render before ended, nor whose the prompts of its empty queue are", async () => {
    const ids: string[] = [];
    for (const prompt of ["zz-test a", "zz-test b", "zz-test c", "zz-test d"]) ids.push((await post(t.app, "/api/jobs", job({ prompt }))).json().ids[0] as string);
    let from = 0;
    for (let i = 0; i < ids.length; i++) {
      await until(() => fake.prompts.size === i + 1, 20_000);
      if (i === 1) from = fake.calls.length;
      const id = [...fake.prompts.keys()][i]!;
      complete(fake, id);
      fake.send("executing", { node: null, prompt_id: id });
      fake.send("status", { status: { exec_info: { queue_remaining: 0 } } });
    }
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "=", "done").execute()).length === ids.length, 20_000);
    // from the second prompt to the end: two gaps between prompts, and the last job's filing
    const asked = fake.calls.slice(from);
    const of = (call: string) => asked.filter((c) => c === call).length;
    console.log(`[round trips] /system_stats ${of("GET /system_stats")}, /queue ${of("GET /queue")}, all ${asked.length}`);
    expect(of("GET /system_stats")).toBe(0);
    // read only on its socket saying it has a prompt (whose it is), not on its queue's emptying: 7 reads before
    expect(of("GET /queue")).toBeLessThanOrEqual(2);
  });
});
