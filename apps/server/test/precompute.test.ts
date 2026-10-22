import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/pool";
import { Precompute, precomputeOf } from "../src/precompute";
import type { TimelineMedia } from "../src/timelineMedia";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, makeApp, post, until, type TestApp } from "./helpers";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("the pool's last lane", () => {
  it("lets work a screen waits on overtake what is measured in the background", async () => {
    const run = pool(1);
    const started: string[] = [];
    const job = (name: string) => async () => {
      started.push(name);
      await tick(2);
    };
    await Promise.all([run(job("strip"), {}), run(job("background 1"), { last: true }), run(job("background 2"), { last: true }), run(job("strip 2")), run(job("motion"), { first: true })]);
    expect(started).toEqual(["strip", "motion", "strip 2", "background 1", "background 2"]);
  });

  it("never takes the last free place, so that what is asked for next starts at once", async () => {
    const run = pool(2);
    const started: string[] = [];
    let release!: () => void;
    const busy = run(() => new Promise<void>((r) => (release = r)));
    const background = run(async () => void started.push("background"), { last: true });
    await tick();
    // one place is free, but it is the last one: the background waits
    expect(started).toEqual([]);
    await run(async () => void started.push("screen"));
    expect(started).toEqual(["screen"]);
    release();
    await Promise.all([busy, background]);
    expect(started).toEqual(["screen", "background"]);
  });

  it("runs work asked for inside a place it already holds in that place, rather than waiting for a second", async () => {
    const run = pool(1);
    const got = await run(() => run(() => run(async () => 7, { first: true })), { last: true });
    expect(got).toBe(7);
  });
});

/** A two-second test clip, made once for the file. Skipped where ffmpeg is not installed. */
let clip: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) clip = await patternClip(2, { fps: 16 });
}, FFMPEG_TIMEOUT);

describe.skipIf(!ffmpegThere)("what the editor reads, measured in the background", () => {
  let t: TestApp;
  let pc: Precompute;
  let calls: string[];
  /** The media module, each measure it is asked for noted. */
  const counted = (): Pick<TimelineMedia, "motion" | "strip" | "means" | "joins" | "missing" | "measureTogether"> => {
    const real = t.services.timelines.media;
    return {
      motion: (id) => (calls.push(`motion:${id}`), real.motion(id)),
      strip: (id) => (calls.push(`strip:${id}`), real.strip(id)),
      means: (a) => (calls.push(`means:${a.id}`), real.means(a)),
      joins: (id, most) => (calls.push(`joins:${id}`), real.joins(id, most)),
      missing: (a) => real.missing(a),
      measureTogether: (a, missing) => (calls.push(`together:${a.id}`), real.measureTogether(a, missing)),
    };
  };
  const upload = async (name: string) =>
    (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip) })).json() as { id: string };
  const has = (key: string) => t.services.storage.size(key).then(() => true, () => false);
  const kept = (id: string) => Promise.all(["motion", "means"].map((d) => has(`${d}/${id.slice(0, 2)}/${id}.json`)).concat(has(`strips/${id.slice(0, 2)}/${id}-2.jpg`)));
  /** A timeline of two clips, the second flowing on from the first. */
  const twoClips = async () => {
    const one = await upload("zz-test one.mp4");
    const two = await upload("zz-test two.mp4");
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test background" })).json() as { id: string };
    const a = (await post(t.app, `/api/timelines/${tl.id}/clips`, { asset: one.id })).json().clip as string;
    const b = (await post(t.app, `/api/timelines/${tl.id}/clips`, { asset: two.id })).json().clip as string;
    await t.app.inject({ method: "PATCH", url: `/api/clips/${b}`, payload: { joined: "continue" } });
    return { one: one.id, two: two.id, tl: tl.id, a, b };
  };

  beforeEach(async () => {
    t = await makeApp();
    calls = [];
    pc = new Precompute(t.db, counted(), { settleMs: 300, backfillAfterMs: null, perMinute: 6000 });
  });
  afterEach(async () => {
    await pc.stop();
    await t.close();
  });

  it("measures a take once it is placed on a timeline: its motion, strip and colour, and the joins of the clip that flows on", async () => {
    expect(precomputeOf(t.db)).toBe(pc);
    const { one, two, b } = await twoClips();
    await until(() => calls.includes(`joins:${b}`));
    await pc.settled();
    expect(await kept(one)).toEqual([true, true, true]);
    expect(await kept(two)).toEqual([true, true, true]);
    expect(await has(`joins/${two.slice(0, 2)}/${two}.json`)).toBe(true);
    // the editor then reads them back: the same figures, no ffmpeg
    const before = calls.length;
    const joins = (await post(t.app, "/api/measures/joins", { ids: [b] })).json().items[b];
    expect(typeof joins[0].in).toBe("number");
    expect((await get(t.app, `/api/assets/${two}/motion`)).json().rate).toBe(10);
    expect(calls.length).toBe(before);
  }, FFMPEG_TIMEOUT);

  it("keeps the joins on the disk: a server started again reads them back instead of measuring", async () => {
    const { b } = await twoClips();
    await until(() => calls.includes(`joins:${b}`));
    await pc.settled();
    const first = (await post(t.app, "/api/measures/joins", { ids: [b] })).json().items[b];
    // a new media module, as after a restart: nothing in memory
    const { TimelineMedia } = await import("../src/timelineMedia");
    const fresh = new TimelineMedia((t.services.timelines.media as unknown as { core: ConstructorParameters<typeof TimelineMedia>[0] }).core);
    const started = Date.now();
    expect(await fresh.joins(b)).toEqual(first);
    expect(Date.now() - started).toBeLessThan(500);
  }, FFMPEG_TIMEOUT);

  it("measures a video once, however often it is stored", async () => {
    const one = await upload("zz-test once.mp4");
    pc.video(one.id);
    pc.video(one.id);
    await pc.settled();
    pc.video(one.id);
    await pc.settled();
    // all three from one decode of it: they were three, 43 CPU-s against 18 for a 1080p 30 s import
    expect(calls.filter((c) => c.endsWith(one.id))).toEqual([`together:${one.id}`]);
    expect(await kept(one.id)).toEqual([true, true, true]);
    // found measured already (by the editor, or before a restart): nothing is measured again
    const again = new Precompute(t.db, counted(), { backfillAfterMs: null });
    calls = [];
    again.video(one.id);
    await again.settled();
    expect(calls).toEqual([]);
    await again.stop();
  }, FFMPEG_TIMEOUT);

  it("makes the strip of a video past a minute by its keyframes, the rest in the one decode", async () => {
    const { ffmpegMade } = await import("./clipKit");
    const { filmStrip } = await import("../src/cut");
    const long = await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=64x36:rate=10:duration=70", "-c:v", "libx264", "-g", "100", "-pix_fmt", "yuv420p"]);
    const one = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20long.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(long) })).json() as { id: string; durationMs: number };
    pc.video(one.id);
    await pc.settled();
    expect(calls.filter((c) => c.endsWith(one.id))).toEqual([`together:${one.id}`]);
    const strip = await t.services.storage.get(`strips/${one.id.slice(0, 2)}/${one.id}-2.jpg`);
    expect(Buffer.from(strip).equals(Buffer.from(await filmStrip(long, "mp4", one.durationMs)))).toBe(true);
  }, FFMPEG_TIMEOUT);

  it("starts nothing while a render's result is being filed", async () => {
    const one = await upload("zz-test held.mp4");
    const done = pc.hold();
    pc.video(one.id);
    await tick(200);
    expect(calls).toEqual([]);
    done();
    await pc.settled();
    expect(calls).toContain(`together:${one.id}`);
  }, FFMPEG_TIMEOUT);

  it("runs in the pool's last lane", async () => {
    const lanes: Array<{ last?: boolean }> = [];
    const own = new Precompute(t.db, counted(), { backfillAfterMs: null, run: (work, opts) => (lanes.push(opts), work()) });
    const one = await upload("zz-test lane.mp4");
    own.video(one.id);
    await own.settled();
    expect(lanes.length).toBe(1);
    expect(lanes.every((l) => l.last)).toBe(true);
    await own.stop();
  }, FFMPEG_TIMEOUT);

  it("forgets what waits when stopped, and nothing breaks: the editor measures on demand", async () => {
    const one = await upload("zz-test stop.mp4");
    const two = await upload("zz-test stop 2.mp4");
    const done = pc.hold();
    pc.video(one.id);
    pc.video(two.id);
    expect(pc.waiting).toBeGreaterThan(0);
    await pc.stop();
    done();
    expect(pc.waiting).toBe(0);
    expect(calls).toEqual([]);
    // what was never measured is measured when asked for, as before
    expect(await kept(one.id)).toEqual([false, false, false]);
    expect((await post(t.app, "/api/measures/motion", { ids: [one.id] })).json().items[one.id].rate).toBe(10);
    // asked for after a stop: nothing is queued
    pc.video(two.id);
    expect(pc.waiting).toBe(0);
  }, FFMPEG_TIMEOUT);

  it("fills in the timelines that lack what their editor reads, and passes over the ones that have it", async () => {
    // placed while nothing listened (a server from before this, or a restart before it was measured)
    await pc.stop();
    const { one, two, b } = await twoClips();
    const filler = new Precompute(t.db, counted(), { backfillAfterMs: null, perMinute: 6000 });
    await filler.backfill();
    await filler.settled();
    expect(await kept(one)).toEqual([true, true, true]);
    expect(await kept(two)).toEqual([true, true, true]);
    expect(calls).toContain(`joins:${b}`);
    calls = [];
    await filler.backfill();
    await filler.settled();
    // the second pass only reads the kept joins back
    expect(calls).toEqual([`joins:${b}`]);
    await filler.stop();
  }, FFMPEG_TIMEOUT);
});
