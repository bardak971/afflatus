import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { TimelineEdit } from "../src/mcpTimelines";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { until } from "./helpers";
import { timelineSteps, timelineSuite } from "./timelineKit";

/**
 * The timelines from outside, phase 5 (mcpTimelines.ts): In and Out (timeline_range), a plan of clips, a swap clip's mask,
 * a take removed and the unused ones binned, through the SDK's own client over HTTP on a pretend ComfyUI with H3's files.
 * The money rules: a slow motion and a mask are renders (the token's renders an hour; its jobs carry the token, so that
 * one without Spend stays off rented pods), and a slow cut done again stays the token's.
 */

const s = timelineSuite();
const steps = timelineSteps(s);

/** A token's client, and the token's id; `rendersPerHour` set on it when given. */
async function connect(start: "look" | "make" = "make", rendersPerHour?: number): Promise<{ c: Client; id: string }> {
  const res = await s.t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  const id = res.json().view.id as string;
  if (rendersPerHour !== undefined) expect((await s.t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { rendersPerHour } })).statusCode).toBe(200);
  if (!s.t.app.server.listening) await s.t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (s.t.app.server.address() as AddressInfo).port;
  const c = new Client({ name: "Claude Code", version: "2.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${res.json().token as string}` } } }));
  return { c, id };
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r));
};
const refused = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};

/** The "timelineEdit" events sent while `work` runs (the change itself, not the word sent before it). */
async function heard(work: () => Promise<unknown>): Promise<TimelineEdit[]> {
  const got: TimelineEdit[] = [];
  const on = (e: TimelineEdit) => void (e.going || got.push(e));
  s.t.services.queue.events.on("timelineEdit", on);
  try {
    await work();
  } finally {
    s.t.services.queue.events.off("timelineEdit", on);
  }
  return got;
}

const jobsOf = (ids: string[]) => s.t.db.selectFrom("jobs").select(["id", "recipe_id", "status", "mcp_token_id"]).where("id", "in", ids).execute();
const ended = (ids: string[]) => until(async () => (await jobsOf(ids)).every((j) => !["queued", "running"].includes(j.status)), 120_000);

/** Two H3 clips planned on a new timeline (the second carrying on from the first), rendered: the timeline's id. */
async function twoRendered(c: Client): Promise<string> {
  const { id } = await ok(c, "new_timeline", { name: "zz-test evening" });
  await ok(c, "plan_clips", { timeline: id, form: "h3.video", clips: [{ description: "zz-test she walks to the window." }, { description: "zz-test she opens it." }] });
  await ok(c, "render_clips", { timeline: id });
  for (const n of [1, 2]) await steps.finish(s.clips.three, n);
  return id;
}

describe.skipIf(!ffmpegThere)("the timelines from outside, phase 5", { timeout: FFMPEG_TIMEOUT * 4 }, () => {
  it("are Make's: a Look token sees them and is refused each", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c: make } = await connect();
    const { id } = await ok(make, "new_timeline", { name: "zz-test look" });
    const { c: look } = await connect("look");
    const names = (await look.listTools()).tools.map((x) => x.name);
    for (const n of ["timeline_range", "plan_clips", "mask_preview", "remove_take", "bin_unused_takes"]) expect(names).toContain(n);
    await refused(look, "timeline_range", { timeline: id, action: "slow", inMs: 0, outMs: 1000 }, /needs Make/);
    await refused(look, "plan_clips", { timeline: id, form: "h3.video", clips: [{ description: "zz-test" }] }, /needs Make/);
    await refused(look, "mask_preview", { timeline: id, clip: 1 }, /needs Make/);
    await refused(look, "remove_take", { timeline: id, clip: 1, take: 1 }, /needs Make/);
    await refused(look, "bin_unused_takes", { timeline: id }, /needs Make/);
    await look.close();
    await make.close();
  });

  it("plans clips in one step of Undo, said live, each text checked as the form checks it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c } = await connect();
    const { id } = await ok(c, "new_timeline", { name: "zz-test plan" });
    await refused(c, "plan_clips", { timeline: id, form: "h3.video", clips: [{ nothing: "x" }] }, /has no input nothing/);
    let r: { clips: number[]; said: string } | undefined;
    const got = await heard(async () => {
      r = await ok(c, "plan_clips", { timeline: id, form: "h3.video", clips: [{ description: "zz-test shot 1" }, { description: "zz-test shot 2" }, { description: "zz-test shot 3" }] });
    });
    expect(r).toMatchObject({ clips: [1, 2, 3], said: expect.stringMatching(/nothing rendered yet.*undo takes them all back/) });
    expect(got).toHaveLength(1);
    expect(got[0]!.clips).toHaveLength(3);
    const read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips.map((x: { values: { description: string } }) => x.values.description)).toEqual(["zz-test shot 1", "zz-test shot 2", "zz-test shot 3"]);
    expect(read.clips[1].join.joined).toBe("seamless");
    await ok(c, "undo", { timeline: id });
    expect((await ok(c, "read_timeline", { timeline: id })).clips).toHaveLength(0);
    await c.close();
  });

  it("acts on In and Out: split, remove, regenerate, copy, and a slow motion held to the token's rules, done again as the token's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c, id: token } = await connect();
    const id = await twoRendered(c);
    const count = async () => (await ok(c, "read_timeline", { timeline: id })).clips.length as number;

    const split = await heard(() => ok(c, "timeline_range", { timeline: id, action: "split", inMs: 1000, outMs: 2000 }));
    expect(split).toHaveLength(1);
    expect(await count()).toBe(4);
    await ok(c, "undo", { timeline: id });
    expect(await count()).toBe(2);

    expect((await ok(c, "timeline_range", { timeline: id, action: "remove", inMs: 1000, outMs: 2000 })).done).toMatch(/the clips after closed the gap\. undo brings it back/);
    expect((await ok(c, "read_timeline", { timeline: id })).length.renderedMs).toBeLessThan(5200);
    await ok(c, "undo", { timeline: id });

    const regen = await ok(c, "timeline_range", { timeline: id, action: "regenerate", inMs: 1000, outMs: 2000 });
    expect(regen).toMatchObject({ clip: expect.any(Number), said: expect.stringMatching(/not rendered: render_clips renders it/) });
    expect((await ok(c, "read_timeline", { timeline: id })).clips[regen.clip - 1].take).toBeNull();
    await ok(c, "undo", { timeline: id });
    expect(await count()).toBe(2);

    const copy = await ok(c, "timeline_range", { timeline: id, action: "copy", inMs: 500, outMs: 2500 });
    expect((await jobsOf([copy.job]))[0]).toMatchObject({ recipe_id: "afflatus.export" });
    await ended([copy.job]);

    // across both clips: two parts, two cut jobs, each the token's (counted against its renders, kept off pods without Spend)
    const slow = await ok(c, "timeline_range", { timeline: id, action: "slow", inMs: 2000, outMs: 4000, factor: 2 });
    expect(slow.jobs).toHaveLength(2);
    expect(slow.on).toMatch(/no Spend/);
    const cuts = await jobsOf(slow.jobs);
    expect(cuts.every((j) => j.recipe_id === "afflatus.cut" && j.mcp_token_id === token)).toBe(true);
    expect(await s.t.services.mcp.tokens.rendersThisHour(token)).toBe(2 + 2);
    await ended(slow.jobs);

    // done again (retry): the slowed cut stays under the token's rules, as a render done again does (Queue.again)
    const again = await ok(c, "retry", { job: slow.jobs[0] });
    expect((await jobsOf([again.job]))[0]).toMatchObject({ recipe_id: "afflatus.cut", mcp_token_id: token });
    await ended([again.job]);
    await c.close();
  });

  it("refuses a slow motion past the token's renders an hour, the timeline left as it was", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c, id: token } = await connect("make", 3);
    const id = await twoRendered(c);
    // two renders went: a slow motion over both clips is two more
    await refused(c, "timeline_range", { timeline: id, action: "slow", inMs: 1000, outMs: 5000 }, /limit is 3 renders an hour, and 2 went/);
    expect((await ok(c, "read_timeline", { timeline: id })).clips).toHaveLength(2);
    expect(await s.t.db.selectFrom("jobs").select("id").where("recipe_id", "=", "afflatus.cut").execute()).toEqual([]);
    // within it: one part, slowed as the token's
    const one = await ok(c, "timeline_range", { timeline: id, action: "slow", inMs: 1000, outMs: 2000 });
    expect((await jobsOf(one.jobs)).map((j) => j.mcp_token_id)).toEqual([token]);
    await ended(one.jobs);
    await c.close();
  });

  it("slows a range of a library video through cut_range as the token's render", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c, id: token } = await connect();
    const id = await twoRendered(c);
    const video = (await ok(c, "read_timeline", { timeline: id })).clips[0].take.item as string;
    const r = await ok(c, "cut_range", { item: video, startMs: 500, endMs: 1500, action: "slow", factor: 2 });
    expect(r.on).toMatch(/no Spend/);
    expect((await jobsOf([r.job]))[0]).toMatchObject({ recipe_id: "afflatus.cut", mcp_token_id: token });
    await ended([r.job]);
    // a copy is ffmpeg on this computer: no render of the token's
    const copy = await ok(c, "cut_range", { item: video, startMs: 500, endMs: 1500, action: "copy" });
    expect((await jobsOf([copy.job]))[0]!.mcp_token_id).toBeNull();
    await ended([copy.job]);
    await c.close();
  });

  it("removes a take to the bin and bins the unused ones, undo bringing them back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c } = await connect();
    const id = await twoRendered(c);
    expect(await ok(c, "bin_unused_takes", { timeline: id })).toMatchObject({ binned: 0 });
    // two more takes of clip 1: three in all, the newest playing
    await ok(c, "render_clips", { timeline: id, clips: [1] });
    await steps.finish(s.clips.three, 3);
    await ok(c, "render_clips", { timeline: id, clips: [1] });
    await steps.finish(s.clips.three, 4);
    let read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[0].otherTakes).toHaveLength(2);
    const first = read.clips[0].otherTakes[0];

    const got = await heard(async () => {
      const r = await ok(c, "remove_take", { timeline: id, clip: 1, take: first.n });
      expect(r).toMatchObject({ removed: `take ${first.n} of clip 1`, video: expect.stringMatching(/went to the bin: restore brings it back/), undo: expect.stringMatching(/undo brings the take back/) });
    });
    expect(got).toHaveLength(1);
    expect((await s.t.db.selectFrom("assets").select("deleted_at").where("id", "=", first.item).executeTakeFirstOrThrow()).deleted_at).toBeTruthy();
    await ok(c, "undo", { timeline: id });
    expect((await s.t.db.selectFrom("assets").select("deleted_at").where("id", "=", first.item).executeTakeFirstOrThrow()).deleted_at).toBeNull();

    // the first take stays: clip 2 carries on from it
    const binned = await ok(c, "bin_unused_takes", { timeline: id });
    expect(binned).toMatchObject({ binned: 1, said: expect.stringMatching(/its video to the bin\. undo brings it back/) });
    expect(binned.bytes).toBeGreaterThan(0);
    read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[0].otherTakes).toEqual([expect.objectContaining({ id: first.id })]);
    await ok(c, "undo", { timeline: id });
    expect((await ok(c, "read_timeline", { timeline: id })).clips[0].otherTakes).toHaveLength(2);
    await c.close();
  });

  it("shows a swap clip's mask as the token's render, and refuses another clip", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { c, id: token } = await connect();
    const id = await twoRendered(c);
    await refused(c, "mask_preview", { timeline: id, clip: 1 }, /Clip 1 is not a swap's clip/);
    const read = await ok(c, "read_timeline", { timeline: id });
    const video = read.clips[0].take.item as string;
    const picture = (await ok(c, "save_frame", { item: video, atMs: 1000 })).item as string;
    await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.swap" }, { do: "join", clip: 3, join: "cut" }] });
    await ok(c, "edit_clip", { timeline: id, clip: 3, set: { who: "zz-test the woman", source: { asset: video }, references: [{ asset: picture, role: "person" }], maskOn: true } });
    const r = await ok(c, "mask_preview", { timeline: id, clip: 3 });
    expect(r).toMatchObject({ clip: 3, job: expect.any(String), on: expect.stringMatching(/no Spend/) });
    const job = (await s.t.db.selectFrom("jobs").select(["mcp_token_id", "inputs", "clip_id"]).where("id", "=", r.job).executeTakeFirstOrThrow());
    expect(job.mcp_token_id).toBe(token);
    expect(JSON.parse(job.inputs).maskPreview).toBe(true);
    // no take is made: the job is the timeline's, not the clip's
    expect(job.clip_id).toBeNull();
    const follow = await ok(c, "mask_preview", { timeline: id, clip: 3, job: r.job });
    expect(follow).toMatchObject({ job: r.job, clip: 3, status: expect.stringMatching(/queued|running/) });
    await ok(c, "cancel", { job: r.job });
    await c.close();
  });
});
