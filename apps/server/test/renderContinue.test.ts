import { beforeEach, describe, expect, it } from "vitest";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { post, type TestApp } from "./helpers";
import { timelineSteps, timelineSuite } from "./timelineKit";

/**
 * The timeline's Render of a clip that carries on from the clip before (card #128): it waits for that clip's take on its
 * way, or is refused with none there and none coming, as Again is (card #127); a batch with such a clip is refused whole.
 */

const s = timelineSuite();
const { call, render, twoClips } = timelineSteps(s);
let t: TestApp;
beforeEach(() => void ({ t } = s));

const job = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const queued = async () => (await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute()).length;
/** The answer of a Render asked, refused or not. */
const ask = (timeline: string, clips: string[]) =>
  post(t.app, `/api/timelines/${timeline}/render`, { clips: clips.map((id) => ({ id, input: { description: "She walks to the window." } })) });

/** A timeline of `count` clips of H3, each carrying on from the one before, none rendered yet. */
async function chain(count: number) {
  const tl = await call("POST", "/api/timelines", { name: "zz-test render carries on" });
  const clips: string[] = [(await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string];
  for (let i = 1; i < count; i++) clips.push((await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string);
  return { id: tl.id as string, clips };
}

describe("Render of a clip that carries on, the clip before with no take", () => {
  it("is refused, and says why, when nothing of the clip before is on its way", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    const res = await ask(id, [clips[1]!]);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Clip 2 carries on from clip 1, which has no take: render clip 1 first, or make their join a cut.");
    expect(await queued()).toBe(0);
  });

  it("refuses the whole batch, naming the clip: the clips before it that could go are not left queued", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(3);
    // the first clip could go alone; the third carries on from the second, not asked and never rendered
    const res = await ask(id, [clips[0]!, clips[2]!]);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Clip 3 carries on from clip 2, which has no take: render clip 2 first, or make their join a cut.");
    expect(await queued()).toBe(0);
  });

  it("waits for the clip before queued in the same batch, a range or the whole timeline", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(3);
    const [first, second, third] = (await render(id, clips.map((c) => ({ id: c })))).ids as string[];
    expect((await job(first!)).depends_on).toBeNull();
    expect((await job(second!)).depends_on).toBe(first);
    expect((await job(third!)).depends_on).toBe(second);
  });

  it("waits for a job of the clip before already waiting, asked on its own", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(2);
    const [first] = (await render(id, [{ id: clips[0]! }])).ids as string[];
    const [second] = (await render(id, [{ id: clips[1]! }])).ids as string[];
    expect((await job(second!)).depends_on).toBe(first);
  });

  it("a cut join, the first clip, and a clip after a still wait for nothing and are sent", async () => {
    await post(t.app, "/api/queue/pause");
    const { id, clips } = await chain(3);
    const [first] = (await render(id, [{ id: clips[0]! }])).ids as string[];
    expect((await job(first!)).depends_on).toBeNull();
    await call("PATCH", `/api/clips/${clips[1]}`, { joined: "cut" });
    const [second] = (await render(id, [{ id: clips[1]! }])).ids as string[];
    expect((await job(second!)).depends_on).toBeNull();
    // the second clip made a still: the third opens on its picture, no take needed
    await t.db.updateTable("clips").set({ kind: "still", recipe_id: null }).where("id", "=", clips[1]!).execute();
    await post(t.app, `/api/jobs/${second}/cancel`);
    const [third] = (await render(id, [{ id: clips[2]! }])).ids as string[];
    expect((await job(third!)).depends_on).toBeNull();
  });
});

describe.skipIf(!ffmpegThere)("Render of a clip that carries on, the clip before rendered", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is sent at once, onto the take that plays", async () => {
    const { id, b } = await twoClips();
    await post(t.app, "/api/queue/pause");
    const [again] = (await render(id, [{ id: b }])).ids as string[];
    expect(await job(again!)).toMatchObject({ status: "queued", depends_on: null, clip_id: b });
  });
});
