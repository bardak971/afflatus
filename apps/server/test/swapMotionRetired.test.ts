import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { migrate, openSqlite, OWNER, type Db } from "../src/db";
import { migratedWindow } from "../src/migrations/0083-swap-motion-retired";
import { withTexts } from "../src/queueSubmit";
import { formFilled } from "../src/timelineModel";

/**
 * H3 · Swap motion retired (card #42, migration 0083): its windows given Swap character or Motion transfer in place,
 * Motion transfer's source video renamed to the swap's ids, wherever the two are kept.
 */
const at = "2026-10-22T10:00:00.000Z";
const WHO = "Replace the woman in <Video 1> with the man in <Picture 1>.";
const swapMotion = { who: WHO, source: { asset: "v1" }, sourceStart: 3, sourceSeconds: 4.4792, references: [{ asset: "r1", role: "person" }], swapStrength: 1.2 };
const carrying = { ...swapMotion, who: "The man carries on moving as in the clip before.", sourceStart: 6.5, sourceSeconds: 5.8958, controlStrength: 0.8 };
const motion = { driving: { asset: "v2" }, drivingStart: 1, drivingSeconds: 5.875, picture: "p1", description: "A man dances." };

async function before(): Promise<Db> {
  const db: Db = openSqlite(":memory:");
  await migrate(db, "0082_timeline_recordings");
  const source = (recipe: string, parked: unknown[] = []) => JSON.stringify({ asset: "v1", atMs: 0, fromMs: 3000, toMs: 20000, windowMs: 5000, recipe, inputs: { who: WHO }, ...(parked.length ? { parked } : {}) });
  const clipRow = (id: string, timeline: string, position: number, recipe: string, joined: string, inputs: unknown) =>
    ({ id, timeline_id: timeline, position, take_id: null, joined, recipe_id: recipe, inputs: JSON.stringify(inputs), created_at: at, updated_at: at });
  const parked = [{ clip: clipRow("parked", "tl", 9, "h3.swapMotion", "continue", carrying), takes: [] }];
  await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "zz-test Swap motion", source: source("h3.swapMotion", parked), created_at: at, updated_at: at } as never).execute();
  await db.insertInto("timelines").values({ id: "tm", owner_id: OWNER, name: "zz-test Motion transfer", source: source("h3.motion"), created_at: at, updated_at: at } as never).execute();
  await db.insertInto("clips").values([
    clipRow("open", "tl", 0, "h3.swapMotion", "cut", swapMotion),
    clipRow("carry", "tl", 1, "h3.swapMotion", "continue", carrying),
    clipRow("hand", "tl", 2, "h3.swapMotion", "continue", { ...carrying, who: "", shiftVideo: 9 }),
    clipRow("moved", "tm", 0, "h3.motion", "cut", motion),
    clipRow("other", "tm", 1, "h3.video", "cut", { description: "driving a car", drivingStart: 2 }),
  ] as never).execute();
  await db.insertInto("timeline_history").values({ id: "h1", timeline_id: "tl", seq: 1, label: "the 3 clips made from the source", snapshot: JSON.stringify({ timeline: { id: "tl", source: source("h3.swapMotion") }, clips: [clipRow("carry", "tl", 1, "h3.swapMotion", "continue", carrying)], takes: [] }), created_at: at } as never).execute();
  const job = (id: string, recipe: string, inputs: unknown) => ({ id, owner_id: OWNER, recipe_id: recipe, label: "x", inputs: JSON.stringify(inputs), status: "done", priority: 0, clip_id: null, created_at: at, updated_at: at });
  await db.insertInto("jobs").values([job("j-open", "h3.swapMotion", swapMotion), job("j-carry", "h3.swapMotion", { ...carrying, previous: { asset: "w1" } }), job("j-motion", "h3.motion", motion)] as never).execute();
  await db.insertInto("drafts").values({ id: "d1", owner_id: OWNER, target: "video", recipe_id: "h3.swapMotion", title: "", forms: JSON.stringify({ "h3.swapMotion": { who: WHO }, "h3.motion": motion }), count: 1, created_at: at, updated_at: at } as never).execute();
  return db;
}

describe("H3 · Swap motion retired (migration 0083)", () => {
  it("gives each window its form in place: a swap where a shot opens, Motion transfer where it carries on, its prompt and the swap's shifts kept", async () => {
    const db = await before();
    expect(await migrate(db)).toContain("0083_swap_motion_retired");
    const clips = Object.fromEntries((await db.selectFrom("clips").select(["id", "recipe_id", "inputs"]).execute()).map((c) => [c.id, { recipe: c.recipe_id, inputs: JSON.parse(c.inputs) as Record<string, unknown> }]));
    expect(clips.open).toEqual({ recipe: "h3.swap", inputs: swapMotion });
    expect(clips.carry!.recipe).toBe("h3.motion");
    expect(clips.carry!.inputs).toMatchObject({ afterSwap: true, source: { asset: "v1" }, sourceStart: 6.5, description: "The man carries on moving as in the clip before.", shiftVideo: 12, shiftAudio: 3, controlStrength: 0.8, references: swapMotion.references });
    expect(clips.carry!.inputs.picture).toBeUndefined();
    // nothing typed: its prompt written from the parts; a shift set by hand stays
    expect(clips.hand!.inputs.description).toBeUndefined();
    expect(clips.hand!.inputs.shiftVideo).toBe(9);
    // Motion transfer's own clips read their part by the swap's ids; another form's are left alone
    expect(clips.moved).toEqual({ recipe: "h3.motion", inputs: { source: { asset: "v2" }, sourceStart: 1, sourceSeconds: 5.875, picture: "p1", description: "A man dances." } });
    expect(clips.other!.inputs).toEqual({ description: "driving a car", drivingStart: 2 });
    // the source's own model, and a window set aside by a trim
    const plan = JSON.parse((await db.selectFrom("timelines").select("source").where("id", "=", "tl").executeTakeFirstOrThrow()).source!);
    expect(plan.recipe).toBe("h3.swap");
    expect(plan.parked[0].clip.recipe_id).toBe("h3.motion");
    expect(JSON.parse(plan.parked[0].clip.inputs)).toMatchObject({ description: "The man carries on moving as in the clip before." });
    // Undo brings back what it is now, not a form that is gone
    const snap = JSON.parse((await db.selectFrom("timeline_history").select("snapshot").executeTakeFirstOrThrow()).snapshot);
    expect(snap.clips[0].recipe_id).toBe("h3.motion");
    expect(JSON.parse(snap.timeline.source).recipe).toBe("h3.swap");
    // a job opened or finished again in its form: the one that carried on had a clip before
    const jobs = Object.fromEntries((await db.selectFrom("jobs").select(["id", "recipe_id", "inputs"]).execute()).map((j) => [j.id, { recipe: j.recipe_id, inputs: JSON.parse(j.inputs) as Record<string, unknown> }]));
    expect(jobs["j-open"]!.recipe).toBe("h3.swap");
    expect(jobs["j-carry"]).toMatchObject({ recipe: "h3.motion", inputs: { description: "The man carries on moving as in the clip before.", shiftVideo: 12 } });
    expect(jobs["j-motion"]!.inputs).toMatchObject({ source: { asset: "v2" }, sourceStart: 1 });
    expect(jobs["j-motion"]!.inputs.driving).toBeUndefined();
    // a draft's Swap motion form opens as Swap character, its Motion transfer form renamed
    const draft = await db.selectFrom("drafts").select(["recipe_id", "forms"]).executeTakeFirstOrThrow();
    expect(draft.recipe_id).toBe("h3.swap");
    expect(JSON.parse(draft.forms!)).toEqual({ "h3.swap": { who: WHO }, "h3.motion": { source: { asset: "v2" }, sourceStart: 1, sourceSeconds: 5.875, picture: "p1", description: "A man dances." } });
  });

  it("leaves a window after a swap without a Picture wherever a form is filled in for a build, and ready to render on a timeline", () => {
    const motion = recipeById("h3.motion")!;
    // filled in for a Load or for the files a job takes (a rented pod is sent them): no stand-in Picture, so the swap's model
    expect((withTexts(motion, { afterSwap: true, source: { asset: "v1" }, previous: { asset: "w1" } }) as Record<string, unknown>).picture).toBeUndefined();
    // a window that carries on is ready without one; a Motion transfer that opens is not
    const inputs = { source: { asset: "v1" }, sourceStart: 0, sourceSeconds: 5 };
    expect(formFilled(motion, inputs, { carries: true, afterStill: false })).toBe(true);
    expect(formFilled(motion, inputs, { carries: false, afterStill: false })).toBe(false);
  });

  it("maps a window that carried on to a Motion transfer that builds Swap motion's graph: no Picture, the swap's model", () => {
    const { recipe, inputs } = migratedWindow(carrying, false);
    const r = recipeById(recipe)!;
    const ids = new Set(r.inputs.map((i) => i.id));
    const input = parseInput(r, { ...Object.fromEntries(Object.entries(inputs).filter(([k]) => ids.has(k))), previous: { asset: "w1" } });
    const built = r.build(input, dryContext({
      slots: { clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", h3Control: "cn.safetensors" },
      uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" },
      media: { source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true }, previous: { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true } },
    }));
    const nodes = Object.values(built.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>);
    expect(nodes.filter((n) => n.class_type === "UNETLoader").map((n) => n.inputs.unet_name)).toEqual(["minimax_h3_fused_refdelta_r1024_turbo8.safetensors"]);
    expect(nodes.some((n) => n.class_type === "MiniMaxH3FunControlNetApply")).toBe(true);
    expect(nodes.find((n) => n.class_type === "MiniMaxH3SigmaShift")?.inputs).toMatchObject({ shift_video: 12, shift_audio: 3 });
  });
});
