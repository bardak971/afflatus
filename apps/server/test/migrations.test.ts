import { describe, expect, it } from "vitest";
import { migrate, openSqlite, OWNER } from "../src/db";

describe("migration 0032, the timeline of a job", () => {
  it("is filled in for the exports and cuts there were: from an export's inputs, from a cut's clip", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0031_take_lead");
    const at = new Date().toISOString();
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Old", width: null, height: null, created_at: at, updated_at: at } as never).execute();
    await db.insertInto("clips").values({ id: "clip", timeline_id: "tl", position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: at, updated_at: at } as never).execute();
    const job = (id: string, recipe: string, inputs: unknown) => ({
      id, owner_id: OWNER, recipe_id: recipe, label: id, inputs: JSON.stringify(inputs), status: "done", priority: 20, depends_on: null, attempts: 1, resume: null, error: null, generation_id: null,
      created_at: at, started_at: at, finished_at: at, updated_at: at,
    });
    await db.insertInto("jobs").values(job("export", "afflatus.export", { timeline: "tl", scale: 1, music: true }) as never).execute();
    await db.insertInto("jobs").values(job("cut", "afflatus.cut", { asset: "a", startMs: 0, endMs: 1000, action: "slow", clip: "clip" }) as never).execute();
    await db.insertInto("jobs").values(job("loose-cut", "afflatus.cut", { asset: "a", startMs: 0, endMs: 1000, action: "copy" }) as never).execute();
    await db.insertInto("jobs").values(job("render", "sdxl.text-to-picture", { prompt: "a cat" }) as never).execute();

    const ran = await migrate(db);
    expect(ran).toContain("0032_job_timeline");
    const timelines = Object.fromEntries((await db.selectFrom("jobs").select(["id", "timeline_id"]).execute()).map((r) => [r.id, r.timeline_id]));
    expect(timelines).toEqual({ export: "tl", cut: "tl", "loose-cut": null, render: null });
    await db.destroy();
  });
});
