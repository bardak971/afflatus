import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { trimOut } from "../src/timelines";
import { makeApp, png, type TestApp } from "./helpers";

/**
 * A source's windows and a recording's Lip sync clips trimmed in and out after Make (Timelines.trimSource, trimRecording,
 * and the rule they share, trimIn and trimOut): what is set aside comes back as it was, and no take is ever lost on the
 * way. Takes and jobs are rows put in by hand; nothing is rendered. The recording is a sound ffmpeg makes.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const inj = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as "POST", url, payload: payload as object });
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await inj(method, url, payload);
  if (res.statusCode >= 400) throw Object.assign(new Error(`${method} ${url}: ${res.statusCode} ${res.body}`), { statusCode: res.statusCode });
  return res.json();
};
const view = (id: string) => call("GET", `/api/timelines/${id}`);

async function asset(kind: "video" | "image") {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind, origin: "uploaded", name: "zz-test", file_key: `assets/${id.slice(0, 2)}/${id}`, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: 1000,
    width: 480, height: 854, duration_ms: kind === "video" ? 28000 : null, fps: kind === "video" ? 24 : null, has_sound: kind === "video" ? 1 : 0, folder_id: null, generation_id: null, kept_at: now(),
  })).execute();
  return id;
}
/** A take landed on the clip, as a render's would, playing. */
async function takeFor(clipId: string) {
  const video = await asset("video");
  const take = newId();
  await t.db.insertInto("takes").values({ id: take, clip_id: clipId, asset_id: video, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() } as never).execute();
  await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clipId).execute();
  return take;
}
const queued = (clipId: string, recipe: string) =>
  t.db.insertInto("jobs").values({ id: newId(), owner_id: "local", recipe_id: recipe, label: "zz-test", inputs: "{}", status: "running", priority: 0, clip_id: clipId, created_at: now(), updated_at: now() } as never).execute();
const busyIds = async () => new Set((await t.db.selectFrom("jobs").select("clip_id").where("status", "in", ["queued", "running"]).execute()).map((j) => j.clip_id));
const steps = async (tl: string) => (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", tl).execute()).length;
/** A deterministic draw, so that every run walks the same steps. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** A swap of 20 s or 28 s of a video, made into its windows. */
async function madeSwap(toMs = 20000) {
  const tl = (await call("POST", "/api/timelines", { name: "zz-test trims" })).id as string;
  const meme = await asset("video");
  const photo = await asset("image");
  await call("PATCH", `/api/timelines/${tl}`, { source: { asset: meme } });
  await call("PATCH", `/api/timelines/${tl}`, { source: { fromMs: 0, toMs, recipe: "h3.swap", inputs: { who: "Swap the man in <Video 1> with the character in <Picture 1>.", references: [{ asset: photo, role: "person" }] } } });
  await call("POST", `/api/timelines/${tl}/source/make`);
  return tl;
}
/** The source's windows and what is set aside, as the database has them. */
async function sourceState(tl: string) {
  const clips = await t.db.selectFrom("clips").selectAll().where("timeline_id", "=", tl).orderBy("position").execute();
  const row = await t.db.selectFrom("timelines").select("source").where("id", "=", tl).executeTakeFirstOrThrow();
  const src = JSON.parse(String(row.source)) as { toMs: number; parked?: Array<{ clip: { id: string; take_id: string | null; inputs: string }; takes: Array<{ id: string }> }>; shortened?: unknown };
  const takes = clips.length ? await t.db.selectFrom("takes").select("id").where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
  return {
    clips: clips.map((c) => { const i = JSON.parse(c.inputs); return { id: c.id, recipe: c.recipe_id, s: (i.sourceStart ?? i.drivingStart) as number, n: (i.sourceSeconds ?? i.drivingSeconds) as number, take: c.take_id }; }),
    takes: takes.map((x) => x.id).sort(),
    toMs: src.toMs,
    parked: (src.parked ?? []).map((p) => ({ id: p.clip.id, take: p.clip.take_id, takes: p.takes.map((x) => x.id), n: JSON.parse(p.clip.inputs).sourceSeconds as number })),
    shortened: src.shortened ?? null,
  };
}
const allTakes = (s: { takes: string[]; parked: Array<{ takes?: string[]; take?: string | null }> }) => new Set([...s.takes, ...s.parked.flatMap((p) => p.takes ?? (p.take ? [p.take] : []))]);

const SEGS = [4.5, 5.1, 4.6, 3.8, 5.2, 4.7];
let wav: Uint8Array | null = null;
/** A recording of six phrases with a pause between each, in the library. */
async function recording(): Promise<string> {
  if (!wav) {
    const dir = mkdtempSync(join(tmpdir(), "zz-test-recording-"));
    try {
      const out = join(dir, "talk.wav");
      const parts = SEGS.flatMap((s, k) => [`sine=frequency=220:duration=${s}`, ...(k < SEGS.length - 1 ? ["anullsrc=r=48000:cl=mono,atrim=duration=0.4"] : [])]);
      const filter = `${parts.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`).join(";")};${parts.map((_, k) => `[a${k}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
      const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...parts.flatMap((p) => ["-f", "lavfi", "-i", p]), "-filter_complex", filter, "-map", "[out]", out]);
      if (r.status !== 0) throw new Error(String(r.stderr));
      wav = new Uint8Array(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}`;
  await t.services.storage.put(key, wav);
  const ms = Math.round((SEGS.reduce((a, b) => a + b, 0) + 0.4 * (SEGS.length - 1)) * 1000);
  await t.db.insertInto("assets").values(newAssetRow({ id, kind: "audio", origin: "uploaded", name: "zz-test talking.wav", file_key: key, thumb_key: null, mime: "audio/wav", bytes: 1000, width: null, height: null, duration_ms: ms, fps: null, has_sound: 1, folder_id: null, generation_id: null, kept_at: now() })).execute();
  return id;
}
/** A recording's clips and what is set aside of it, as the database has them. */
async function recordingState(tl: string) {
  const clips = await t.db.selectFrom("clips").selectAll().where("timeline_id", "=", tl).orderBy("position").execute();
  const row = await t.db.selectFrom("timelines").select("recordings").where("id", "=", tl).executeTakeFirstOrThrow();
  const rec = JSON.parse(String(row.recordings ?? "{}")) as Record<string, unknown>;
  const parked = Object.values(rec).flatMap((v) => (Array.isArray(v) ? (v as Array<{ clip: { id: string; take_id: string | null; inputs: string }; takes: Array<{ id: string }> }>) : []));
  const takes = clips.length ? await t.db.selectFrom("takes").select("id").where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
  return {
    clips: clips.map((c) => { const i = JSON.parse(c.inputs); return { id: c.id, s: i.recordingStart as number, n: i.recordingSeconds as number, take: c.take_id }; }),
    takes: takes.map((x) => x.id).sort(),
    parked: parked.map((p) => ({ id: p.clip.id, take: p.clip.take_id, takes: p.takes.map((x) => x.id), s: JSON.parse(p.clip.inputs).recordingStart as number, n: JSON.parse(p.clip.inputs).recordingSeconds as number })),
    shortened: rec.shortened ?? null,
  };
}

describe("trimOut, the rule an end trimmed out follows", () => {
  const last = { start: 0, end: 4000, free: false };
  it("stops the end at a gap that cannot close when a clip set aside past it has a take: none of them dropped", () => {
    const rows = [{ start: 5000, end: 10000, fits: true }, { start: 10000, end: 15000, fits: true, taken: true }];
    expect(trimOut(last, rows, 20000, { fromMs: 0 })).toEqual({ back: 0, end: 4000, keep: true, more: false, lastEnd: undefined });
    // one of another model with a take: kept aside all the same
    expect(trimOut(last, [{ start: 0, end: 0, fits: false, taken: true }], 20000, { fromMs: 0 })).toMatchObject({ keep: true, more: false });
    // none with a take: they go, and new clips are made past the last one
    expect(trimOut(last, rows.map((r) => ({ ...r, taken: false })), 20000, { fromMs: 0 })).toMatchObject({ keep: false, more: true });
  });

  it("adds no clip shorter than a clip can be past a gap it drops at, as past the clips it brings back", () => {
    const rows = [{ start: 5000, end: 10000, fits: true }];
    expect(trimOut(last, rows, 6000, { fromMs: 0, leastMs: 4000, mostMs: 14000 })).toMatchObject({ keep: false, more: false, end: 4000 });
  });

  it("gives an empty last clip back any length a trim in took off, a frame's too", () => {
    expect(trimOut({ start: 0, end: 4970, free: true, reach: 5000 }, [{ start: 5000, end: 10000, fits: true }], 20000, { fromMs: 0 })).toMatchObject({ lastEnd: 5000, back: 1, end: 10000 });
  });
});

describe("a source's windows trimmed", () => {
  it("keeps the windows set aside, takes and all, when the window shortened has rendered since (case E): the end stops there", async () => {
    const tl = await madeSwap();
    const v = await view(tl);
    const ids = v.clips.map((c: { id: string }) => c.id);
    await takeFor(ids[2]);
    await takeFor(ids[3]);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round(v.clips[1].inputs.sourceStart * 1000) + 4000 });
    const shortened = await sourceState(tl);
    expect(shortened.clips.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(shortened.parked.filter((p) => p.take)).toHaveLength(2);
    // the shortened window rendered as it is
    await takeFor(ids[1]);
    const before = await sourceState(tl);
    const r = await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 20000 });
    const after = await sourceState(tl);
    expect(r.toMs).toBe(before.toMs);
    expect(after).toEqual(before);
    expect([...allTakes(before)].every((x) => allTakes(after).has(x))).toBe(true);
  });

  it("records a window shortened within a rounding of its end, and the end out gives it its whole length back", async () => {
    const tl = await madeSwap();
    const v = await view(tl);
    const c2 = v.clips[2];
    const end = Math.round((c2.inputs.sourceStart + c2.inputs.sourceSeconds) * 1000);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: end - 30 });
    const s = await sourceState(tl);
    expect(s.clips).toHaveLength(3);
    expect(s.shortened).toEqual({ clip: c2.id, seconds: c2.inputs.sourceSeconds });
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 20000 });
    const out = await view(tl);
    expect(out.clips.map((c: { id: string }) => c.id)).toEqual(v.clips.map((c: { id: string }) => c.id));
    expect(out.clips.map((c: { inputs: { sourceSeconds: number } }) => c.inputs.sourceSeconds)).toEqual(v.clips.map((c: { inputs: { sourceSeconds: number } }) => c.inputs.sourceSeconds));
  });

  it("passes a rendered window set aside under a model gone since: kept aside with its take, said once, the end goes on (T-26)", async () => {
    const tl = await madeSwap();
    const v = await view(tl);
    const ids = v.clips.map((c: { id: string }) => c.id);
    const take = await takeFor(ids[3]);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round(v.clips[1].inputs.sourceStart * 1000) + 4000 });
    const row = await t.db.selectFrom("timelines").select("source").where("id", "=", tl).executeTakeFirstOrThrow();
    const src = JSON.parse(String(row.source)) as { parked: Array<{ clip: { id: string; recipe_id: string } }> };
    expect(src.parked.map((p) => p.clip.id)).toEqual([ids[2], ids[3]]);
    src.parked[1]!.clip.recipe_id = "zz-test.gone";
    await t.db.updateTable("timelines").set({ source: JSON.stringify(src) }).where("id", "=", tl).execute();
    const r = await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 20000 });
    expect(r.toMs).toBe(20000);
    expect(r.said).toMatch(/stays aside with its takes/);
    const out = await sourceState(tl);
    expect(out.clips.map((c) => c.id).slice(0, 3)).toEqual(ids.slice(0, 3));
    expect(out.clips.length).toBeGreaterThan(3);
    expect(out.parked).toEqual([expect.objectContaining({ id: ids[3], takes: [take] })]);
    // said once: a trim in and out again passes it without a word
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 15000 });
    const again = await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 20000 });
    expect(again.said).toBeUndefined();
    expect(allTakes(await sourceState(tl)).has(take)).toBe(true);
  });

  it("sets a window shortened, then rendered at that length, aside at its rendered length: the end out stops at it (T-23)", async () => {
    const tl = await madeSwap();
    const v = await view(tl);
    const c2 = v.clips[2];
    const start = c2.inputs.sourceStart as number;
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((start + c2.inputs.sourceSeconds - 1) * 1000) });
    const short = (await sourceState(tl)).clips[2]!.n;
    expect(short).toBeLessThan(c2.inputs.sourceSeconds);
    const take = await takeFor(c2.id);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((start + 1.5) * 1000) });
    const aside = await sourceState(tl);
    expect(aside.parked[0]).toMatchObject({ id: c2.id, n: short });
    expect(aside.shortened).toBeNull();
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 20000 });
    const out = await sourceState(tl);
    const back = out.clips.find((c) => c.id === c2.id) ?? out.parked.find((p) => p.id === c2.id);
    expect(back?.n).toBe(short);
    expect(allTakes(out).has(take)).toBe(true);
  });
});

describe("a source cut again (card #42's forms per window)", () => {
  /** Every window with a prompt of its own; window 3 given Swap character by itself, with its own `who`. */
  async function owned() {
    const tl = await madeSwap(28000);
    let v = await view(tl);
    for (const [k, c] of v.clips.entries()) await call("PATCH", `/api/clips/${c.id}`, { inputs: { ...c.inputs, happens: `H${k} window ${k}.`, ...(k ? { description: `D${k} window ${k}.` } : {}) } });
    v = await view(tl);
    await call("POST", `/api/timelines/${tl}/source/window`, { clip: v.clips[3].id, recipe: "h3.swap" });
    v = await view(tl);
    await call("PATCH", `/api/clips/${v.clips[3].id}`, { inputs: { ...v.clips[3].inputs, who: "W3 a swap of its own.", happens: "H3 swapped." } });
    return { tl, v: await view(tl) };
  }
  const said = (v: { clips: Array<{ inputs: Record<string, unknown> }> }) => v.clips.flatMap((c) => [c.inputs.who, c.inputs.description, c.inputs.happens]).map(String).join(" | ");

  it("keeps each window's own form, its own who and its description when the windows land where they were", async () => {
    const { tl, v } = await owned();
    await takeFor(v.clips[0].id);
    // a window longer than H3 takes: the windows come out the same
    await call("PATCH", `/api/timelines/${tl}`, { source: { windowMs: 8000 } });
    await call("POST", `/api/timelines/${tl}/source/make`, { again: true });
    const out = await view(tl);
    expect(out.clips).toHaveLength(v.clips.length);
    for (const [k, c] of out.clips.entries()) expect(c.inputs.sourceStart).toBeCloseTo(v.clips[k].inputs.sourceStart, 2);
    expect(out.clips.map((c: { recipe: string }) => c.recipe)).toEqual(v.clips.map((c: { recipe: string }) => c.recipe));
    for (const [k, c] of out.clips.entries()) {
      expect(c.inputs.happens).toBe(v.clips[k].inputs.happens);
      expect(c.inputs.description).toBe(v.clips[k].inputs.description);
    }
    expect(out.clips[3].inputs.who).toBe("W3 a swap of its own.");
  });

  it("loses no prompt when the windows move: one no new window lies over goes to the nearest", async () => {
    const { tl, v } = await owned();
    await call("PATCH", `/api/timelines/${tl}`, { source: { windowMs: 3000 } });
    await call("POST", `/api/timelines/${tl}/source/make`, { again: true });
    const out = await view(tl);
    expect(out.clips.length).not.toBe(v.clips.length);
    const text = said(out);
    for (const c of v.clips) for (const k of ["description", "happens"]) if (c.inputs[k]) expect(text).toContain(c.inputs[k]);
    expect(text).toContain("W3 a swap of its own.");
  });
});

describe("a recording's clips trimmed", () => {
  it("sets a clip shortened before aside at its length before, so that it meets the next one again (case H)", async () => {
    const tl = (await call("POST", "/api/timelines", { name: "zz-test recording" })).id as string;
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl}/recording`, { asset: sound });
    const made = await recordingState(tl);
    const take = await takeFor(clips[2]);
    const c1 = made.clips[1]!;
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((c1.s + c1.n - 0.8) * 1000) });
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((c1.s + 1) * 1000) });
    const aside = await recordingState(tl);
    expect(aside.parked[0]).toMatchObject({ id: c1.id, n: c1.n });
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: 30000 });
    const out = await recordingState(tl);
    expect(out.clips.map((c) => [c.id, c.s, c.n])).toEqual(made.clips.map((c) => [c.id, c.s, c.n]));
    expect(out.clips[2]!.take).toBe(take);
    expect(out.parked).toEqual([]);
    expect(out.shortened).toBeNull();
  });

  it("sets a clip shortened, then rendered at that length, aside at its rendered length: it never comes back longer (T-23)", async () => {
    const tl = (await call("POST", "/api/timelines", { name: "zz-test recording" })).id as string;
    const sound = await recording();
    await call("POST", `/api/timelines/${tl}/recording`, { asset: sound });
    const c2 = (await recordingState(tl)).clips[2]!;
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((c2.s + c2.n - 0.8) * 1000) });
    const short = (await recordingState(tl)).clips[2]!.n;
    expect(short).toBeLessThan(c2.n);
    const take = await takeFor(c2.id);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((c2.s + 1) * 1000) });
    const aside = await recordingState(tl);
    expect(aside.parked[0]).toMatchObject({ id: c2.id, n: short });
    expect(aside.shortened).toBeNull();
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: 30000 });
    const out = await recordingState(tl);
    const back = out.clips.find((c) => c.id === c2.id) ?? out.parked.find((p) => p.id === c2.id);
    expect(back?.n).toBe(short);
    expect(new Set([...out.takes, ...out.parked.flatMap((p) => p.takes)]).has(take)).toBe(true);
  });
});

describe("trims fuzzed (seeded, the same steps every run)", () => {
  /**
   * One trim, checked: its Undo gives the state before back exactly and its Redo the state after; a trim that keeps no
   * step changes nothing. Then no take is lost (placed or set aside), and no window that renders is touched.
   */
  async function checked<S extends { takes: string[]; parked: Array<{ takes: string[] }>; clips: Array<{ id: string; n: number }> }>(tl: string, state: (tl: string) => Promise<S>, trim: () => Promise<{ statusCode: number; body: string }>, where: string) {
    const before = await state(tl);
    const n0 = await steps(tl);
    const busy = await busyIds();
    const res = await trim();
    if (res.statusCode >= 400) {
      expect(res.statusCode, `${where}: ${res.body}`).toBe(409);
      expect(await state(tl), where).toEqual(before);
      return before;
    }
    const after = await state(tl);
    if ((await steps(tl)) > n0) {
      await call("POST", `/api/timelines/${tl}/undo`);
      expect(await state(tl), `${where}: undo`).toEqual(before);
      await call("POST", `/api/timelines/${tl}/redo`);
      expect(await state(tl), `${where}: redo`).toEqual(after);
    } else expect(after, `${where}: no step`).toEqual(before);
    const have = allTakes(after);
    expect([...allTakes(before)].filter((x) => !have.has(x)), `${where}: takes lost`).toEqual([]);
    for (const c of before.clips) if (busy.has(c.id)) expect(after.clips.find((x) => x.id === c.id)?.n, `${where}: busy window touched`).toBe(c.n);
    return after;
  }
  /** Now and then a render ends (its job gone, a take landed), and the last clip, empty, is rendered as it is. */
  async function renders(r: () => number, last: { id: string } | undefined) {
    if (r() < 0.2) {
      const jobs = await t.db.selectFrom("jobs").select(["id", "clip_id"]).where("status", "in", ["queued", "running"]).execute();
      const j = jobs[Math.floor(r() * jobs.length)];
      if (j) {
        await t.db.deleteFrom("jobs").where("id", "=", j.id).execute();
        if (r() < 0.6 && j.clip_id && (await t.db.selectFrom("clips").select("id").where("id", "=", j.clip_id).executeTakeFirst())) await takeFor(j.clip_id);
      }
    }
    if (last && r() < 0.25) {
      const row = await t.db.selectFrom("clips").select("take_id").where("id", "=", last.id).executeTakeFirst();
      if (row && !row.take_id && !(await busyIds()).has(last.id)) await takeFor(last.id);
    }
  }

  it("the source: no take lost, no window under the fewest frames, Undo and Redo exact", async () => {
    const least = (90 / 24) * 1000;
    for (let seed = 1; seed <= 12; seed++) {
      await t.close();
      t = await makeApp();
      const r = rng(seed);
      const tl = await madeSwap(28000);
      for (const [k, c] of (await sourceState(tl)).clips.entries()) {
        const x = k === 0 ? 0 : Math.floor(r() * 4);
        if (x === 2) await takeFor(c.id);
        if (x === 3) await queued(c.id, c.recipe ?? "h3.swap");
      }
      for (let i = 0; i < 10; i++) {
        await renders(r, (await sourceState(tl)).clips.at(-1));
        const toMs = Math.round(1000 + r() * 27000);
        const s = await checked(tl, sourceState, () => inj("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs }), `seed ${seed} step ${i} to ${toMs}`);
        for (const c of s.clips.slice(1)) expect(c.n * 1000, `seed ${seed} step ${i}: a window under the fewest frames`).toBeGreaterThanOrEqual(least - 1);
      }
    }
  }, 120000);

  it("a recording: no take lost, no clip under the fewest seconds, the clips meeting, Undo and Redo exact", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      await t.close();
      t = await makeApp();
      const r = rng(seed);
      const tl = (await call("POST", "/api/timelines", { name: "zz-test recording" })).id as string;
      const sound = await recording();
      await call("POST", `/api/timelines/${tl}/recording`, { asset: sound });
      for (const [k, c] of (await recordingState(tl)).clips.entries()) {
        const x = k === 0 ? 0 : Math.floor(r() * 4);
        if (x === 2) await takeFor(c.id);
        if (x === 3) await queued(c.id, "h3.lipsync");
      }
      for (let i = 0; i < 10; i++) {
        await renders(r, (await recordingState(tl)).clips.at(-1));
        const toMs = Math.round(1000 + r() * 29000);
        const s = await checked(tl, recordingState, () => inj("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs }), `seed ${seed} step ${i} to ${toMs}`);
        for (const [k, c] of s.clips.entries()) {
          if (k === 0) continue;
          expect(c.n, `seed ${seed} step ${i}: a clip under the fewest seconds`).toBeGreaterThanOrEqual(4 - 1e-6);
          const p = s.clips[k - 1]!;
          expect(Math.abs(p.s + p.n - c.s), `seed ${seed} step ${i}: a gap before clip ${k + 1}`).toBeLessThanOrEqual(0.05);
        }
      }
    }
  }, 120000);
});

describe("Undo and Redo over renders (T-24)", () => {
  const assetOf = async (take: string) => (await t.db.selectFrom("takes").select("asset_id").where("id", "=", take).executeTakeFirstOrThrow()).asset_id;
  const futures = async (tl: string) => (await t.db.selectFrom("timeline_future").select("seq").where("timeline_id", "=", tl).execute()).length;

  it("refuses an Undo or a Redo that would resize, set aside or remove a clip in the queue, and writes nothing", async () => {
    const tl = await madeSwap();
    const w2 = (await sourceState(tl)).clips[2]!;
    // the trim in shortens window 3, sent to render: its Undo would give it its length back under the render
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((w2.s + w2.n - 1) * 1000) });
    await queued(w2.id, w2.recipe ?? "h3.swap");
    const before = await sourceState(tl);
    const n = await steps(tl);
    const r = await inj("POST", `/api/timelines/${tl}/undo`);
    expect(r.statusCode).toBe(409);
    expect(r.json().message ?? r.body).toMatch(/Clip 3 is rendering or in the queue/);
    expect(await sourceState(tl)).toEqual(before);
    expect([await steps(tl), await futures(tl)]).toEqual([n, 0]);
    // its render over, the Undo goes through
    await t.db.deleteFrom("jobs").execute();
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await sourceState(tl)).clips[2]!.n).toBe(w2.n);
    // a Redo that would set aside a window in the queue: refused too
    await queued(before.parked[0]!.id, w2.recipe ?? "h3.swap");
    expect((await inj("POST", `/api/timelines/${tl}/redo`)).statusCode).toBe(409);
    expect(await futures(tl)).toBe(1);
  });

  it("refuses the Undo of a trim out that made the window in the queue", async () => {
    const tl = await madeSwap();
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 12000 });
    const r = await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 28000 });
    expect(r.clips.length).toBeGreaterThan(0);
    await queued(r.clips[0], "h3.swap");
    expect((await inj("POST", `/api/timelines/${tl}/undo`)).statusCode).toBe(409);
    expect((await sourceState(tl)).clips.some((c) => c.id === r.clips[0])).toBe(true);
  });

  it("keeps a take rendered since off a clip put back at another length, its video kept, and Redo puts it back", async () => {
    const tl = await madeSwap();
    const w2 = (await sourceState(tl)).clips[2]!;
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((w2.s + w2.n - 1) * 1000) });
    const short = (await sourceState(tl)).clips[2]!.n;
    const take = await takeFor(w2.id);
    const video = await assetOf(take);
    await t.db.updateTable("assets").set({ kept_at: null }).where("id", "=", video).execute();
    const u = await call("POST", `/api/timelines/${tl}/undo`);
    expect(u.said).toMatch(/clip 3 does not fit that clip at this step: its video stays kept in the library, and Redo puts it back/);
    const undone = await sourceState(tl);
    expect(undone.clips[2]).toMatchObject({ id: w2.id, n: w2.n, take: null });
    expect(allTakes(undone).has(take)).toBe(false);
    expect((await t.db.selectFrom("assets").select("kept_at").where("id", "=", video).executeTakeFirstOrThrow()).kept_at).not.toBeNull();
    await call("POST", `/api/timelines/${tl}/redo`);
    expect((await sourceState(tl)).clips[2]).toMatchObject({ id: w2.id, n: short, take });
  });

  it("keeps a take on a window the undone trim out brought back with that window, set aside, and says so of one on a window it made", async () => {
    const tl = await madeSwap();
    const all = (await sourceState(tl)).clips.map((c) => c.id);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 12000 });
    const aside = (await sourceState(tl)).parked.map((p) => p.id);
    expect(aside.length).toBeGreaterThan(0);
    const r = await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: 28000 });
    const out = await sourceState(tl);
    const brought = out.clips.find((c) => aside.includes(c.id))!;
    const made = out.clips.find((c) => r.clips.includes(c.id))!;
    expect(all).toContain(brought.id);
    const kept = await takeFor(brought.id);
    const left = await takeFor(made.id);
    const leftVideo = await assetOf(left);
    const u = await call("POST", `/api/timelines/${tl}/undo`);
    const undone = await sourceState(tl);
    expect(undone.parked.find((p) => p.id === brought.id)).toMatchObject({ take: kept, takes: [kept] });
    // named as the Undo leaves the timeline: the window it is on is gone, so no number from before the step
    expect(u.said).toMatch(/^The take rendered since on a clip this Undo takes off has no clip at this step: its video stays kept in the library, and Redo puts it back\.$/);
    expect((await t.db.selectFrom("assets").select(["kept_at", "deleted_at"]).where("id", "=", leftVideo).executeTakeFirstOrThrow()).deleted_at).toBeNull();
    // the trim out again brings the window back with its take
    await call("POST", `/api/timelines/${tl}/redo`);
    const redone = await sourceState(tl);
    expect(redone.clips.find((c) => c.id === brought.id)?.take).toBe(kept);
    expect(redone.clips.find((c) => c.id === made.id)?.take).toBe(left);
  });
});

describe("the library's Bin and Unkeep and what only Undo names (T-27)", () => {
  it("bins and unkeeps a picture only a timeline's Undo names, and its Undo takes it back out of the bin", async () => {
    const tl = await madeSwap();
    const src = JSON.parse(String((await t.db.selectFrom("timelines").select("source").where("id", "=", tl).executeTakeFirstOrThrow()).source));
    const old = src.inputs.references[0].asset as string;
    const fresh = await asset("image");
    await call("PATCH", `/api/timelines/${tl}`, { source: { inputs: { ...src.inputs, references: [{ asset: fresh, role: "person" }] } } });
    expect((await inj("POST", `/api/assets/${old}/keep`, { kept: false })).statusCode).toBe(200);
    expect((await inj("DELETE", `/api/assets/${old}`)).statusCode).toBe(200);
    const bulk = await call("POST", "/api/assets/bulk", { ids: [old], action: "bin" });
    expect(bulk.inUse).toBeUndefined();
    // what is placed still refuses
    expect((await inj("DELETE", `/api/assets/${fresh}`)).statusCode).toBe(409);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await t.db.selectFrom("assets").select("deleted_at").where("id", "=", old).executeTakeFirstOrThrow()).deleted_at).toBeNull();
  });

  it("puts a linked folder's picture its Undo takes out of the bin back into its directory, as the bin's Restore does (T-30)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zz-test-linked-"));
    try {
      writeFileSync(join(dir, "one.png"), png(16, 24));
      const folder = (await call("POST", "/api/folders/link", { path: dir, name: "zz-test Shoots" })).id as string;
      const pic = await t.db.selectFrom("assets").selectAll().where("name", "=", "one.png").executeTakeFirstOrThrow();
      const tl = await madeSwap();
      const src = JSON.parse(String((await t.db.selectFrom("timelines").select("source").where("id", "=", tl).executeTakeFirstOrThrow()).source));
      await call("PATCH", `/api/timelines/${tl}`, { source: { inputs: { ...src.inputs, references: [{ asset: pic.id, role: "person" }] } } });
      await call("PATCH", `/api/timelines/${tl}`, { source: { inputs: src.inputs } });
      // named only by Undo now: it can be binned, and its file leaves the directory
      expect((await inj("DELETE", `/api/assets/${pic.id}`)).statusCode).toBe(200);
      expect(existsSync(join(dir, "one.png"))).toBe(false);
      await call("POST", `/api/timelines/${tl}/undo`);
      const back = await t.db.selectFrom("assets").selectAll().where("id", "=", pic.id).executeTakeFirstOrThrow();
      expect(back).toMatchObject({ deleted_at: null, linked_path: null, folder_id: folder, file_key: `linked:${join(dir, "one.png")}` });
      expect(existsSync(join(dir, "one.png"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** What the database keeps of the parts removed from the middle (card #75): the source's, then each recording's. */
async function removedState(tl: string) {
  const row = await t.db.selectFrom("timelines").select(["source", "recordings"]).where("id", "=", tl).executeTakeFirstOrThrow();
  type Part = { before: string; joined: string; inputs?: string; rows: Array<{ clip: { id: string }; takes: Array<{ id: string }> }> };
  const src = JSON.parse(String(row.source ?? "null")) as { removed?: Part[] } | null;
  const rec = JSON.parse(String(row.recordings ?? "{}")) as { removed?: Record<string, Part[]> };
  const parts = [...(src?.removed ?? []), ...Object.values(rec.removed ?? {}).flat()];
  return parts.map((p) => ({ before: p.before, joined: p.joined, moved: p.inputs !== undefined, ids: p.rows.map((r) => r.clip.id), takes: p.rows.flatMap((r) => r.takes.map((x) => x.id)) }));
}
const joins = async (tl: string) => (await t.db.selectFrom("clips").select(["id", "joined"]).where("timeline_id", "=", tl).orderBy("position").execute()).map((c) => [c.id, c.joined]);

describe("a clip removed from a recording cuts its part out (card #75)", () => {
  async function song() {
    const tl = (await call("POST", "/api/timelines", { name: "zz-test removed" })).id as string;
    const sound = await recording();
    await call("POST", `/api/timelines/${tl}/recording`, { asset: sound });
    const made = await recordingState(tl);
    expect(made.clips.length).toBeGreaterThanOrEqual(5);
    return { tl, sound, made, ids: made.clips.map((c) => c.id) };
  }

  it("sets a clip in the middle aside with its takes, makes the clip after it a cut, and Undo or Bring back puts it all back", async () => {
    const { tl, made, ids } = await song();
    const take = await takeFor(ids[2]!);
    const before = { clips: await recordingState(tl), joins: await joins(tl) };
    expect(before.joins[3]![1]).toBe("continue");
    await call("DELETE", `/api/clips/${ids[2]}`);
    const cut = await recordingState(tl);
    expect(cut.clips.map((c) => c.id)).toEqual(ids.filter((id) => id !== ids[2]));
    // the clips after it keep their own part: the recording jumps over the removed one
    expect(cut.clips[2]).toMatchObject({ id: ids[3], s: made.clips[3]!.s });
    expect(cut.parked).toEqual([]);
    expect(await removedState(tl)).toEqual([{ before: ids[3], joined: "continue", moved: false, ids: [ids[2]], takes: [take] }]);
    expect((await joins(tl))[2]).toEqual([ids[3], "cut"]);
    // the editor is told where and how long
    const rec = (await view(tl)).recordings[0];
    expect(rec.removed).toEqual([{ before: ids[3], fromMs: Math.round(made.clips[2]!.s * 1000), toMs: Math.round((made.clips[2]!.s + made.clips[2]!.n) * 1000), clips: 1, takes: 1 }]);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect({ clips: await recordingState(tl), joins: await joins(tl) }).toEqual(before);
    expect(await removedState(tl)).toEqual([]);
    // removed again, and brought back from its mark: as before, its take playing, the join after it carrying on again
    await call("DELETE", `/api/clips/${ids[2]}`);
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: ids[3] });
    expect({ clips: await recordingState(tl), joins: await joins(tl) }).toEqual(before);
    expect(await removedState(tl)).toEqual([]);
    expect((await view(tl)).recordings[0].removed).toEqual([]);
  });

  it("removes the first clip as the In moved past it, and sets the last aside as the Out brought in before it: the Out moved out brings it back", async () => {
    const { tl, sound, made, ids } = await song();
    await call("DELETE", `/api/clips/${ids[0]}`);
    const first = await recordingState(tl);
    expect(first.clips.map((c) => c.id)).toEqual(ids.slice(1));
    expect(first.parked).toEqual([]);
    expect(await removedState(tl)).toEqual([]);
    // the clip first now opens the recording as the removed one did
    expect((await joins(tl))[0]).toEqual([ids[1], "cut"]);
    const last = ids.at(-1)!;
    await call("DELETE", `/api/clips/${last}`);
    const shorter = await recordingState(tl);
    expect(shorter.clips.map((c) => c.id)).toEqual(ids.slice(1, -1));
    expect(shorter.parked.map((p) => p.id)).toEqual([last]);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: Math.round(made.clips[1]!.s * 1000), toMs: 30000 });
    expect((await recordingState(tl)).clips.map((c) => c.id)).toEqual(ids.slice(1));
  });

  it("removes the clips picked in one step, a part for each run of them, and two next to each other as one part", async () => {
    const { tl, ids } = await song();
    const steps0 = await steps(tl);
    await call("POST", `/api/timelines/${tl}/clips/remove`, { ids: [ids[1], ids[3]] });
    expect(await steps(tl)).toBe(steps0 + 1);
    expect((await removedState(tl)).map((p) => [p.before, p.ids])).toEqual([[ids[2], [ids[1]]], [ids[4], [ids[3]]]]);
    // the clip between them removed too: one part of three clips, the clip after them its join back as it was when it returns
    await call("DELETE", `/api/clips/${ids[2]}`);
    expect((await removedState(tl)).map((p) => [p.before, p.ids, p.joined])).toEqual([[ids[4], [ids[1], ids[2], ids[3]], "continue"]]);
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: ids[4] });
    expect((await joins(tl)).map(([id]) => id)).toEqual(ids);
    expect((await joins(tl)).slice(1).every(([, j]) => j === "continue")).toBe(true);
  });

  it("folds a removed part back among the clips an Out brought in sets aside, so that the Out moved out brings them all back", async () => {
    const { tl, sound, made, ids } = await song();
    await call("DELETE", `/api/clips/${ids[3]}`);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((made.clips[1]!.s + made.clips[1]!.n) * 1000) });
    const aside = await recordingState(tl);
    expect(aside.parked.map((p) => p.id)).toEqual(ids.slice(2));
    expect(await removedState(tl)).toEqual([]);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: 30000 });
    expect((await joins(tl)).map(([id]) => id)).toEqual(ids);
    expect((await joins(tl))[4]).toEqual([ids[4], "continue"]);
  });

  it("keeps a part removed when the clip after it was rendered since: the Out in past it and out again brings that clip back as the cut it was rendered as", async () => {
    const { tl, sound, made, ids } = await song();
    await call("DELETE", `/api/clips/${ids[2]}`);
    const take = await takeFor(ids[3]!);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: Math.round((made.clips[1]!.s + made.clips[1]!.n) * 1000) });
    expect((await recordingState(tl)).clips.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect((await removedState(tl)).map((p) => [p.before, p.ids])).toEqual([[ids[3], [ids[2]]]]);
    // the empty clip before the removed part keeps its length: grown up to the clip after it, it would play the removed words
    const lengthOf = async (id: string) => (await recordingState(tl)).clips.find((c) => c.id === id)!.n;
    const before = await lengthOf(ids[1]!);
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: 0, toMs: 30000 });
    expect(await lengthOf(ids[1]!)).toBe(before);
    expect((await joins(tl)).map(([id]) => id)).toEqual(ids.filter((id) => id !== ids[2]));
    expect((await joins(tl))[2]).toEqual([ids[3], "cut"]);
    expect((await recordingState(tl)).clips[2]).toMatchObject({ id: ids[3], take });
    expect((await view(tl)).recordings[0].removed.map((p: { before: string }) => p.before)).toEqual([ids[3]]);
  });

  it("cuts the part out when In / Out's Remove range takes a clip whole: set aside with its takes, the clip after it a cut", async () => {
    const { tl, ids } = await song();
    const takes = [];
    for (const id of ids) takes.push(await takeFor(id));
    const laid = (await view(tl)).clips as Array<{ id: string; atMs: number; lengthMs: number }>;
    const third = laid.find((c) => c.id === ids[2])!;
    expect(third.lengthMs).toBeGreaterThan(0);
    await call("POST", `/api/timelines/${tl}/range`, { inMs: third.atMs, outMs: third.atMs + third.lengthMs, action: "remove" });
    expect((await joins(tl)).map(([id]) => id)).toEqual(ids.filter((id) => id !== ids[2]));
    expect(await removedState(tl)).toEqual([{ before: ids[3], joined: "continue", moved: false, ids: [ids[2]], takes: [takes[2]] }]);
    expect((await joins(tl))[2]).toEqual([ids[3], "cut"]);
    // the last clip taken by the range: set aside as the Out brought in before it, for the Out moved out to bring back
    const last = (await view(tl)).clips.at(-1) as { id: string; atMs: number; lengthMs: number };
    await call("POST", `/api/timelines/${tl}/range`, { inMs: last.atMs, outMs: last.atMs + last.lengthMs, action: "remove" });
    expect((await recordingState(tl)).parked.map((p) => p.id)).toEqual([ids.at(-1)]);
  });

  it("refuses a clip set aside while it renders, as the trims do, and turns the song's hand-over off at the cut", async () => {
    const { ids } = await song();
    await queued(ids[2]!, "h3.lipsync");
    const res = await inj("DELETE", `/api/clips/${ids[2]}`);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/rendering or in the queue/);
    await t.db.deleteFrom("jobs").execute();
    const recipe = t.services.registry.recipe("h3.lipsync")!;
    const inputsOf = async (id: string) => JSON.parse((await t.db.selectFrom("clips").select("inputs").where("id", "=", id).executeTakeFirstOrThrow()).inputs) as Record<string, unknown>;
    const planOf = async (id: string) => t.services.timelines.plan(id, recipe, await inputsOf(id), false, null, true);
    expect((await planOf(ids[1]!)).input.recordingGoesOn).toBe(true);
    await call("DELETE", `/api/clips/${ids[2]}`);
    expect((await planOf(ids[1]!)).input.recordingGoesOn).toBe(false);
  });

  it("leaves a clip of no recording or source as it was: it goes, nothing set aside", async () => {
    const tl = (await call("POST", "/api/timelines", { name: "zz-test plain" })).id as string;
    const a = (await call("POST", `/api/timelines/${tl}/clips`, {})).clip as string;
    const b = (await call("POST", `/api/timelines/${tl}/clips`, {})).clip as string;
    await call("DELETE", `/api/clips/${a}`);
    expect((await joins(tl)).map(([id]) => id)).toEqual([b]);
    expect(await removedState(tl)).toEqual([]);
  });
});

describe("a window removed from a source cuts its part out (card #75)", () => {
  it("sets a window in the middle aside, the window after it a cut starting after its carried frames, and Bring back puts its part back", async () => {
    const tl = await madeSwap();
    const before = await sourceState(tl);
    const ids = before.clips.map((c) => c.id);
    const beforeJoins = await joins(tl);
    expect(beforeJoins[2]![1]).toBe("continue");
    await call("DELETE", `/api/clips/${ids[1]}`);
    const cut = await sourceState(tl);
    expect(cut.clips.map((c) => c.id)).toEqual(ids.filter((id) => id !== ids[1]));
    expect(cut.toMs).toBe(before.toMs);
    expect((await joins(tl))[1]).toEqual([ids[2], "cut"]);
    // a cut, it no longer plays the frames it carried again: its part starts later
    expect(cut.clips[1]!.s).toBeGreaterThan(before.clips[2]!.s);
    expect(await removedState(tl)).toEqual([{ before: ids[2], joined: "continue", moved: true, ids: [ids[1]], takes: [] }]);
    const marked = (await view(tl)).source.removed;
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ before: ids[2], clips: 1, takes: 0 });
    // its own part: after the frames it carried from the window before
    expect(marked[0].fromMs).toBeGreaterThan(Math.round(before.clips[1]!.s * 1000));
    expect(marked[0].toMs).toBe(Math.round((before.clips[1]!.s + before.clips[1]!.n) * 1000));
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: ids[2] });
    expect(await sourceState(tl)).toEqual(before);
    expect(await joins(tl)).toEqual(beforeJoins);
  });

  it("keeps the window after a part its form as a cut when it was rendered since: an Out in past it and out again does not revert it", async () => {
    const tl = await madeSwap();
    const before = await sourceState(tl);
    const ids = before.clips.map((c) => c.id);
    await call("DELETE", `/api/clips/${ids[1]}`);
    const cut = await sourceState(tl);
    const asCut = cut.clips[1]!;
    expect(asCut.id).toBe(ids[2]);
    // rendered as a cut, from its moved start
    const take = await takeFor(ids[2]!);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((cut.clips[0]!.s + cut.clips[0]!.n) * 1000) });
    expect((await sourceState(tl)).clips.map((c) => c.id)).toEqual([ids[0]]);
    // the part stays removed, kept with it while it is set aside
    expect((await removedState(tl)).map((p) => [p.before, p.ids])).toEqual([[ids[2], [ids[1]]]]);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: before.toMs });
    const back = await sourceState(tl);
    expect(back.clips.map((c) => c.id)).toEqual(ids.filter((id) => id !== ids[1]));
    // its take made as a cut plays as one: its join and its start as they were when it was rendered
    expect(back.clips[1]).toMatchObject({ id: ids[2], s: asCut.s, n: asCut.n, take });
    expect((await joins(tl))[1]).toEqual([ids[2], "cut"]);
    // the part marked again, and brought back on its own: the window after it still a cut
    expect((await view(tl)).source.removed.map((p: { before: string }) => p.before)).toEqual([ids[2]]);
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: ids[2] });
    expect((await sourceState(tl)).clips.map((c) => c.id)).toEqual(ids);
    expect((await joins(tl))[2]).toEqual([ids[2], "cut"]);
  });

  it("gives the window after a part its join and form back when it was not rendered since", async () => {
    const tl = await madeSwap();
    const before = await sourceState(tl);
    const ids = before.clips.map((c) => c.id);
    await call("DELETE", `/api/clips/${ids[1]}`);
    const cut = await sourceState(tl);
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: Math.round((cut.clips[0]!.s + cut.clips[0]!.n) * 1000) });
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 0, toMs: before.toMs });
    const back = await sourceState(tl);
    expect(back.clips.map((c) => c.id)).toEqual(ids);
    expect(back.clips[2]).toMatchObject({ id: ids[2], s: before.clips[2]!.s });
    expect((await joins(tl))[2]).toEqual([ids[2], "continue"]);
  });

  it("removes the first window as the In moved past it (the source keeps its place, the click on its first frame goes) and sets the last aside", async () => {
    const tl = await madeSwap();
    await call("PATCH", `/api/timelines/${tl}`, { source: { pick: { x: 0.4, y: 0.3 } } });
    const before = await sourceState(tl);
    const ids = before.clips.map((c) => c.id);
    const plan0 = (await view(tl)).source;
    await call("DELETE", `/api/clips/${ids[0]}`);
    const plan = (await view(tl)).source;
    const firstNow = (await sourceState(tl)).clips[0]!;
    expect(firstNow.id).toBe(ids[1]);
    expect((await joins(tl))[0]).toEqual([ids[1], "cut"]);
    expect(plan.fromMs).toBe(Math.round(firstNow.s * 1000));
    expect(plan.atMs).toBe(plan0.atMs - (plan.fromMs - plan0.fromMs));
    expect(plan.pick).toBeUndefined();
    await call("DELETE", `/api/clips/${ids.at(-1)}`);
    const s = await sourceState(tl);
    expect(s.parked.map((p) => p.id)).toEqual([ids.at(-1)]);
    expect(s.toMs).toBe(Math.round((s.clips.at(-1)!.s + s.clips.at(-1)!.n) * 1000));
  });
});

describe("a re-cut, a moved In or a source made anew keeps the parts removed removed, with their takes (card #114)", () => {
  async function song() {
    const tl = (await call("POST", "/api/timelines", { name: "zz-test removed kept" })).id as string;
    const sound = await recording();
    await call("POST", `/api/timelines/${tl}/recording`, { asset: sound });
    const made = await recordingState(tl);
    expect(made.clips.length).toBeGreaterThanOrEqual(5);
    return { tl, sound, made, ids: made.clips.map((c) => c.id) };
  }
  /** No clip of the recording plays any of `from` to `to` (seconds); the one starting at `to`, as a cut, is returned. */
  async function around(tl: string, from: number, to: number) {
    const s = await recordingState(tl);
    expect(s.clips.filter((c) => c.s < to - 0.01 && c.s + c.n > from + 0.01)).toEqual([]);
    const after = s.clips.find((c) => Math.abs(c.s - to) < 0.02);
    expect(after).toBeDefined();
    expect((await joins(tl)).find(([id]) => id === after!.id)![1]).toBe("cut");
    return after!.id;
  }

  it("cut again at another length: the clips are made around the part removed, kept with the new clip after it, and Bring back puts it back with its take", async () => {
    const { tl, sound, made, ids } = await song();
    const take = await takeFor(ids[2]!);
    await call("DELETE", `/api/clips/${ids[2]}`);
    const gap = made.clips[2]!;
    await call("POST", `/api/timelines/${tl}/recording/cut`, { asset: sound, seconds: 3, snap: false });
    const after = await around(tl, gap.s, gap.s + gap.n);
    expect(after).not.toBe(ids[3]);
    expect(await removedState(tl)).toEqual([{ before: after, joined: "continue", moved: false, ids: [ids[2]], takes: [take] }]);
    expect((await view(tl)).recordings[0].removed).toEqual([{ before: after, fromMs: Math.round(gap.s * 1000), toMs: Math.round((gap.s + gap.n) * 1000), clips: 1, takes: 1 }]);
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: after });
    const back = await recordingState(tl);
    const at = back.clips.findIndex((c) => c.id === ids[2]);
    expect(back.clips[at]).toMatchObject({ s: gap.s, n: gap.n, take });
    expect(back.clips[at + 1]!.id).toBe(after);
    expect((await joins(tl))[at + 1]).toEqual([after, "continue"]);
    expect(await removedState(tl)).toEqual([]);
  });

  it("its start moved: the part removed after the new In stays removed with its take; one before it goes", async () => {
    const { tl, sound, made, ids } = await song();
    const take = await takeFor(ids[3]!);
    await call("POST", `/api/timelines/${tl}/clips/remove`, { ids: [ids[1], ids[3]] });
    const gap = made.clips[3]!;
    const end = made.clips.at(-1)!;
    await call("POST", `/api/timelines/${tl}/recording/trim`, { asset: sound, fromMs: Math.round(made.clips[2]!.s * 1000), toMs: Math.round((end.s + end.n) * 1000) });
    const after = await around(tl, gap.s, gap.s + gap.n);
    expect(await removedState(tl)).toEqual([{ before: after, joined: "continue", moved: false, ids: [ids[3]], takes: [take] }]);
    expect((await recordingState(tl)).clips[0]!.s).toBeCloseTo(made.clips[2]!.s, 2);
  });

  it("a source cut again: the windows are made around the part removed, the one after it a cut, and Bring back gives that one its run-up back", async () => {
    const tl = await madeSwap(28000);
    const before = await sourceState(tl);
    const ids = before.clips.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const take = await takeFor(ids[1]!);
    await call("DELETE", `/api/clips/${ids[1]}`);
    const mark = (await view(tl)).source.removed[0] as { fromMs: number; toMs: number };
    await call("POST", `/api/timelines/${tl}/source/make`, { again: true });
    const s = await sourceState(tl);
    const frame = 1000 / 24;
    const joined = await joins(tl);
    // every window's own frames (past those it carries) out of the part removed; the one after it opens on its end
    const k = s.clips.findIndex((c) => Math.abs(c.s * 1000 - mark.toMs) <= frame);
    expect(k).toBeGreaterThan(0);
    expect(joined[k]![1]).toBe("cut");
    for (const c of s.clips.slice(0, k)) expect(c.s * 1000 + Math.floor(c.n * 24 + 1e-6) * frame).toBeLessThanOrEqual(mark.fromMs + frame);
    const after = s.clips[k]!.id;
    expect(ids).not.toContain(after);
    expect(await removedState(tl)).toEqual([{ before: after, joined: "continue", moved: true, ids: [ids[1]], takes: [take] }]);
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: after });
    const back = await sourceState(tl);
    expect(back.clips[k]).toMatchObject({ id: ids[1], take });
    expect(back.clips[k + 1]!.id).toBe(after);
    expect(back.clips[k + 1]!.s).toBeLessThan(s.clips[k]!.s);
    expect((await joins(tl))[k + 1]).toEqual([after, "continue"]);
  });

  it("a source made anew on another grid: the part removed stays removed, and Bring back puts back windows of the new model", async () => {
    const tl = await madeSwap(28000);
    const ids = (await sourceState(tl)).clips.map((c) => c.id);
    await takeFor(ids[1]!);
    await call("DELETE", `/api/clips/${ids[1]}`);
    const mark = (await view(tl)).source.removed[0] as { fromMs: number; toMs: number };
    const r = await call("POST", `/api/timelines/${tl}/source/form`, { recipe: "scail.motion" });
    expect(r.switched).toBe(false);
    const s = await sourceState(tl);
    expect(s.clips.every((c) => c.recipe === "scail.motion")).toBe(true);
    expect(s.clips.map((c) => c.id)).toEqual(r.clips);
    // the part's span (made anew, its edges where the windows on each side meet it) in no window placed
    const frame = 1000 / 16;
    const now = (await view(tl)).source.removed[0] as { fromMs: number; toMs: number };
    expect(Math.abs(now.fromMs - mark.fromMs)).toBeLessThan(500);
    for (const c of s.clips) expect(c.s * 1000 >= now.toMs - frame || c.s * 1000 + c.n * 1000 <= now.fromMs + 2 * frame).toBe(true);
    const parts = await removedState(tl);
    expect(parts).toHaveLength(1);
    // made anew with the new model, set aside: its old window and take gone from it
    expect(parts[0]!.ids).not.toContain(ids[1]);
    expect(parts[0]!.takes).toEqual([]);
    expect((await view(tl)).source.removed[0]).toMatchObject({ before: parts[0]!.before, takes: 0 });
    await call("POST", `/api/timelines/${tl}/removed/back`, { before: parts[0]!.before });
    const back = await sourceState(tl);
    expect(back.clips.every((c) => c.recipe === "scail.motion")).toBe(true);
    expect(back.clips.length).toBe(s.clips.length + parts[0]!.ids.length);
    expect((await joins(tl)).find(([id]) => id === parts[0]!.before)![1]).toBe("continue");
    expect((await joins(tl)).find(([id]) => id === parts[0]!.ids[0])![1]).toBe("continue");
    // made anew, the part and the windows on each side of it meet end to end: no part of the source left between them
    const ownEnd = (c: { s: number; n: number }) => c.s * 1000 + (Math.floor(c.n * 16 + 1e-6) * 1000) / 16;
    const at = back.clips.findIndex((c) => c.id === parts[0]!.ids[0]);
    const gap = (await view(tl)).source.removed as unknown[];
    expect(gap).toEqual([]);
    const own = (c: { s: number }, j: number) => (j === 0 ? c.s * 1000 : c.s * 1000 + (5 * 1000) / 16);
    for (const j of [at, at + parts[0]!.ids.length]) expect(Math.abs(own(back.clips[j]!, j) - ownEnd(back.clips[j - 1]!))).toBeLessThanOrEqual(1000 / 16);
  });

  it("a source cut again around a part kept as it was: the windows before it reach it exactly, or run past it with their take hiding that much", async () => {
    const tl = await madeSwap(28000);
    const ids = (await sourceState(tl)).clips.map((c) => c.id);
    const take = await takeFor(ids[2]!);
    await call("DELETE", `/api/clips/${ids[2]}`);
    const mark = (await view(tl)).source.removed[0] as { fromMs: number; toMs: number };
    await call("PATCH", `/api/timelines/${tl}`, { source: { windowMs: 3000 } });
    await call("POST", `/api/timelines/${tl}/source/make`, { again: true });
    const parts = await removedState(tl);
    expect(parts).toEqual([expect.objectContaining({ ids: [ids[2]], takes: [take] })]);
    const s = await sourceState(tl);
    const frame = 1000 / 24;
    const k = s.clips.findIndex((c) => c.id === parts[0]!.before);
    const last = s.clips[k - 1]!;
    const end = last.s * 1000 + Math.floor(last.n * 24 + 1e-6) * frame;
    const row = await t.db.selectFrom("timelines").select("source").where("id", "=", tl).executeTakeFirstOrThrow();
    const hidden = (JSON.parse(String(row.source)) as { hidden?: Record<string, number> }).hidden ?? {};
    // never short of the part: its windows shared so that the last one meets it within half a frame, or runs past it by
    // less than a grid step (17 frames) with that much hidden
    expect(end).toBeGreaterThanOrEqual(mark.fromMs - frame / 2);
    expect(end - mark.fromMs).toBeLessThan(17 * frame);
    if (end - mark.fromMs > frame / 2) expect(Math.abs(hidden[last.id]! - (end - mark.fromMs))).toBeLessThanOrEqual(1);
    else expect(hidden).toEqual({});
    // a take landed on a window that hides its end stops playing that much before it
    const video = await t.db.selectFrom("assets").selectAll().where("id", "=", await asset("video")).executeTakeFirstOrThrow();
    const src = JSON.parse(String(row.source)) as Record<string, unknown>;
    const plannedOf = async () => (await t.services.timelines.leaves()).find((x) => x.id === tl)!.plannedMs;
    const planned = await plannedOf();
    await t.db.updateTable("timelines").set({ source: JSON.stringify({ ...src, hidden: { [last.id]: 375 } }) }).where("id", "=", tl).execute();
    // not rendered yet, it is told as long as its take will play: the end it hides left out
    expect((await view(tl)).clips.find((c: { id: string }) => c.id === last.id).hiddenMs).toBe(375);
    expect(await plannedOf()).toBe(planned - 375);
    await t.services.timelines.takes.add(last.id, video, { headMs: 0, tailMs: 0 }, {});
    expect((await t.db.selectFrom("takes").select("trim_end_ms").where("clip_id", "=", last.id).executeTakeFirstOrThrow()).trim_end_ms).toBe(375);
    // the window after the part opens where it ends
    expect(Math.abs(s.clips[k]!.s * 1000 - mark.toMs)).toBeLessThanOrEqual(frame);
  });

  it("a source's start moved: the part removed after the new In stays removed with its take", async () => {
    const tl = await madeSwap(28000);
    const ids = (await sourceState(tl)).clips.map((c) => c.id);
    const take = await takeFor(ids[2]!);
    await call("DELETE", `/api/clips/${ids[2]}`);
    const mark = (await view(tl)).source.removed[0] as { fromMs: number; toMs: number };
    const plan = (await view(tl)).source as { toMs: number };
    await call("POST", `/api/timelines/${tl}/source/trim`, { fromMs: 1000, toMs: plan.toMs });
    const parts = await removedState(tl);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ ids: [ids[2]], takes: [take] });
    const s = await sourceState(tl);
    const k = s.clips.findIndex((c) => c.id === parts[0]!.before);
    expect(s.clips[k]!.s * 1000).toBeGreaterThanOrEqual(mark.toMs - 1000 / 24);
    expect((await joins(tl))[k]![1]).toBe("cut");
    expect((await view(tl)).source.removed).toHaveLength(1);
  });
});
