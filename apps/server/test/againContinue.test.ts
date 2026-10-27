import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, post, until, type TestApp } from "./helpers";
import { nodes, timelineSteps, timelineSuite } from "./timelineKit";

/** "Again" on a clip that carries on from the clip before it, stopped or failed (card #127): what it waits for, and what it joins onto. */

const s = timelineSuite();
const { call, view, finish, render, twoClips } = timelineSteps(s);
let fake: FakeComfy;
let t: TestApp;
let three: Uint8Array;
beforeAll(() => void ({ three } = s.clips ?? {}));
beforeEach(() => void ({ fake, t } = s));

const job = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const cancel = async (id: string) => expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
const again = async (id: string) => {
  const res = await post(t.app, `/api/jobs/${id}/retry`, {});
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json().id as string;
};
/** The take of the clip before a clip's latest take was cut from. */
const joinedOnto = async (timeline: string, clip: number) => {
  const take = (await view(timeline)).clips[clip].take;
  return (await get(t.app, `/api/assets/${take.asset.id}`)).json().sources.find((x: { role: string }) => x.role === "previous")?.asset.id as string | undefined;
};

/** A timeline of `count` clips of H3, each carrying on from the one before, none rendered yet. */
async function chain(count: number) {
  const tl = await call("POST", "/api/timelines", { name: "zz-test again" });
  const clips: string[] = [(await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string];
  for (let i = 1; i < count; i++) clips.push((await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string);
  return { id: tl.id as string, clips };
}

describe("Again on a clip that carries on, the clip before still to render", () => {
  it("waits again for the clip before's job, waiting", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    const [first, second] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(second!);
    const redo = await again(second!);
    expect(await job(redo)).toMatchObject({ status: "queued", depends_on: first, clip_id: clips[1] });
  });

  it("waits for the newest job of the clip before, when that one was queued again since", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    const [, second] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(second!);
    const [more] = (await render(id, [{ id: clips[0]! }])).ids as string[];
    expect((await job(await again(second!))).depends_on).toBe(more);
  });

  it("is refused, and says why, when the clip before has no take and nothing on its way", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    const [first, second] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(first!);
    expect(await job(second!)).toMatchObject({ status: "failed", error: "the clip it continues was not rendered" });
    const res = await post(t.app, `/api/jobs/${second}/retry`, {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Clip 2 carries on from clip 1, which has no take");
    // nothing was queued for it: sent, it would have opened on nothing
    expect(await t.db.selectFrom("jobs").select("id").where("clip_id", "=", clips[1]!).where("status", "=", "queued").execute()).toEqual([]);
    // the clip before queued again first, it waits for that one
    const redoFirst = await again(first!);
    expect((await job(await again(second!))).depends_on).toBe(redoFirst);
  });

  it("a cut clip, or the first one, waits for nothing", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    await call("PATCH", `/api/clips/${clips[1]}`, { joined: "cut" });
    const [first, second] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(first!);
    expect((await job(await again(first!))).depends_on).toBeNull();
    // made a cut, it opens on its own: no take of the clip before is needed
    await cancel(second!);
    expect((await job(await again(second!))).depends_on).toBeNull();
  });
});

describe("Again on the clips a cancel failed", () => {
  it("does not bring them back by itself; each one queued again waits for the one before it, in any order asked", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(3);
    const [first, second, third] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(second!);
    expect(await job(third!)).toMatchObject({ status: "failed", error: "the clip it continues was not rendered" });
    const redo = await again(second!);
    expect((await job(redo)).depends_on).toBe(first);
    // the third clip stays as it ended: only what was asked is queued again
    expect(await t.db.selectFrom("jobs").select("id").where("clip_id", "=", clips[2]!).where("status", "in", ["queued", "running"]).execute()).toEqual([]);
    expect((await job(await again(third!))).depends_on).toBe(redo);
  });

  it("Retry all queues the clip before first, though asked after the clip that continues it", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(3);
    const [first, second, third] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await cancel(second!);
    const res = (await post(t.app, "/api/jobs/retry", { ids: [third, second], dismiss: true })).json() as { ids: string[]; failed: number };
    expect(res.failed).toBe(0);
    const [redoSecond, redoThird] = res.ids;
    expect(await job(redoSecond!)).toMatchObject({ clip_id: clips[1], depends_on: first });
    expect(await job(redoThird!)).toMatchObject({ clip_id: clips[2], depends_on: redoSecond });
  });
});

describe("Again on a finish cut behind a Face refine", () => {
  it("waits again for the refine while it still waits", async () => {
    await post(t.app, "/api/queue/pause");
    const refine = await t.services.queue.enqueue("h3.video", { description: "zz-test" });
    const cut = await t.services.queue.enqueueCut({ asset: "nope", startMs: 0, endMs: 1000, action: "finish", fromJob: refine }, "zz-test finish", { dependsOn: refine });
    await cancel(cut);
    expect((await job(await again(cut))).depends_on).toBe(refine);
  });
});

describe.skipIf(!ffmpegThere)("Again on a clip that carries on, rendered", { timeout: FFMPEG_TIMEOUT }, () => {
  it("stopped while the clip before renders: it waits for that take and joins onto it", async () => {
    const { id, clips } = await chain(2);
    const [first, second] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    await until(() => fake.prompts.size === 1);
    await cancel(second!);
    expect((await job(await again(second!))).depends_on).toBe(first);
    await finish(three, 1);
    const graph = await finish(three, 2);
    // cut from the take the clip before just got: its frames lead the clip in
    expect(nodes(graph, "MiniMaxH3AddGuide")).toHaveLength(1);
    expect(await joinedOnto(id, 1)).toBe((await view(id)).clips[0].take.asset.id);
  });

  it("after the clip before finished: it joins onto the take that plays now, not the one it was first cut from", async () => {
    const { id, a, b } = await twoClips();
    const old = (await view(id)).clips[0].take.asset.id as string;
    const [, second] = (await render(id, [{ id: a }, { id: b }])).ids as string[];
    await until(() => fake.prompts.size === 3);
    await cancel(second!);
    await finish(three, 3);
    const now = (await view(id)).clips[0].take.asset.id as string;
    expect(now).not.toBe(old);
    expect((await job(await again(second!))).depends_on).toBeNull();
    await finish(three, 4);
    expect(await joinedOnto(id, 1)).toBe(now);
  });

  it("after the clip before was stopped too: it joins onto the take of it that plays", async () => {
    const { id, a, b } = await twoClips();
    const playing = (await view(id)).clips[0].take.asset.id as string;
    await post(t.app, "/api/queue/pause");
    const [first, second] = (await render(id, [{ id: a }, { id: b }])).ids as string[];
    await cancel(first!);
    expect((await job(second!)).status).toBe("failed");
    expect((await job(await again(second!))).depends_on).toBeNull();
    await post(t.app, "/api/queue/resume");
    await finish(three, 3);
    expect(await joinedOnto(id, 1)).toBe(playing);
    expect((await view(id)).clips[1].join).toBe("fresh");
  });
});
