import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { trimOut } from "../src/timelines";
import { makeApp, type TestApp } from "./helpers";

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
    clips: clips.map((c) => { const i = JSON.parse(c.inputs); return { id: c.id, recipe: c.recipe_id, s: i.sourceStart as number, n: i.sourceSeconds as number, take: c.take_id }; }),
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
