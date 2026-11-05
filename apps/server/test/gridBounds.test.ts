import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_MOST } from "@afflatus/core";
import { CHECKPOINT, makeApp, post, type TestApp } from "./helpers";

/**
 * A grid's prompts held to the prompt limit before any cell is made (the 2026-11-05 security review, S3): a Prompt S/R
 * value put in place of a short word found all over a long prompt, times a seed axis, made gigabytes of cells before the
 * queue's own limit was asked of the first one.
 */
const recipe = "sdxl.text-to-picture";

describe("a grid's prompts", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  it("refuses a Prompt S/R value that grows a prompt past the limit, queuing nothing and keeping no grid", async () => {
    const input = { prompt: "a ".repeat(5_000).trim(), checkpoint: CHECKPOINT, steps: 30, cfg: 5, seed: -1 };
    const res = await post(t.app, "/api/grids", { recipe, input, axes: [{ field: "sr", values: `a, ${"b".repeat(2_000)}` }, { field: "seed", values: "1-100" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(new RegExp(`^X: .*past ${PROMPT_MOST.toLocaleString("en-US")} characters`));
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    expect(await t.db.selectFrom("grids").select("id").execute()).toEqual([]);
    // the same priced on the card: refused alike, nothing made
    expect((await post(t.app, "/api/grids/plan", { recipe, input, axes: [{ field: "sr", values: `a, ${"b".repeat(2_000)}` }] })).statusCode).toBe(400);
  });

  it("reads the form as the queue will before any cell is made: a prompt past the limit is refused as the form's", async () => {
    const input = { prompt: "x".repeat(PROMPT_MOST + 1), checkpoint: CHECKPOINT, steps: 30, cfg: 5, seed: -1 };
    const res = await post(t.app, "/api/grids", { recipe, input, axes: [{ field: "seed", values: "1, 2" }] });
    expect(res.statusCode).toBe(400);
    expect(await t.db.selectFrom("grids").select("id").execute()).toEqual([]);
  });

  it("takes a Prompt S/R value that keeps every prompt within the limit", async () => {
    const input = { prompt: "a lighthouse in a red coat of paint, dusk", checkpoint: CHECKPOINT, steps: 30, cfg: 5, seed: -1 };
    const res = await post(t.app, "/api/grids", { recipe, input, axes: [{ field: "sr", values: "red coat, blue coat" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
  });

  it("answers a grid sent again with its key as it was, rather than queuing it twice", async () => {
    const input = { prompt: "a lighthouse, dusk", checkpoint: CHECKPOINT, steps: 30, cfg: 5, seed: -1 };
    const body = { recipe, input, axes: [{ field: "cfg", values: "4, 6" }], key: "zz-test-grid-key-1" };
    const first = (await post(t.app, "/api/grids", body)).json() as { id: string };
    const again = (await post(t.app, "/api/grids", body)).json() as { id: string };
    expect(again.id).toBe(first.id);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toHaveLength(2);
    // another click is another grid
    expect((await post(t.app, "/api/grids", { ...body, key: "zz-test-grid-key-2" })).json().id).not.toBe(first.id);
  });
});
