import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeSplits } from "../src/costs";
import { migrate, newId, now, openSqlite, type Db } from "../src/db";
import { duckCurve } from "../src/duck";
import { newAssetRow } from "../src/media";
import { fold } from "../src/renders";
import { createServices } from "../src/services";
import { LocalStorage } from "../src/storage";
import { inUse, sweep, undoNamed, UNKEPT_MS } from "../src/sweep";
import type { AssetRow, Laid } from "../src/timelineModel";
import { CHECKPOINT, FAST, get, makeApp, type TestApp } from "./helpers";

/**
 * What the timeline's work costs the server, counted rather than timed (the performance review of 2026-10-22): the
 * statements and rows a request reads, the transactions it writes in, and whether a long piece of work lets the server
 * answer something else in between. Each of these held the server, at a heavy user's scale, for 0.1 to 1.7 s.
 */

// every statement SQLite runs while `counted` is on: its text and how many rows it gave
const seen: Array<{ sql: string; rows: number }> = [];
let counting = false;
const proto = StatementSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const m of ["all", "get", "run"] as const) {
  const orig = proto[m]!;
  proto[m] = function (this: StatementSync & { sourceSQL: string }, ...a: unknown[]) {
    const out = orig.apply(this, a);
    if (counting) seen.push({ sql: this.sourceSQL.replace(/\s+/g, " "), rows: m === "all" ? (out as unknown[]).length : m === "get" ? (out ? 1 : 0) : 0 });
    return out;
  };
}
async function counted<T>(work: () => Promise<T>): Promise<{ out: T; seen: Array<{ sql: string; rows: number }> }> {
  seen.length = 0;
  counting = true;
  try {
    return { out: await work(), seen: [...seen] };
  } finally {
    counting = false;
  }
}
const matching = (list: Array<{ sql: string; rows: number }>, re: RegExp) => list.filter((s) => re.test(s.sql));

/** Whether the work lets the server in before it ends: an immediate queued as it starts runs first. */
async function letsIn<T>(work: () => Promise<T>): Promise<{ out: T; inBetween: boolean }> {
  let ran = false;
  setImmediate(() => (ran = true));
  const out = await work();
  return { out, inBetween: ran };
}

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};
const timeline = async (name: string) => (await t.services.timelines.create(name)).id;
/** `n` clips at the end of a timeline, planned as the designer does (none rendered). */
const planned = async (tl: string, n: number, text = "zz-test") =>
  (await call("POST", `/api/timelines/${tl}/plan`, { recipe: "h3.video", clips: Array.from({ length: n }, (_, k) => ({ description: `${text} ${k}` })) })).clips as string[];
const order = async (tl: string) => (await t.db.selectFrom("clips").select(["id", "position"]).where("timeline_id", "=", tl).orderBy("position").execute());

async function video(): Promise<AssetRow> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: "generated", name: "v.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: now(),
  })).execute();
  return t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

describe("the editor's forecasts of a timeline's clips (H-2)", () => {
  it("read the timeline once for all its clips, not once per clip", async () => {
    const tl = await timeline("zz-test forecasts");
    const ids = await planned(tl, 5);
    const v = await call("GET", `/api/timelines/${tl}`);
    const forms = v.clips.map((c: { id: string; recipe: string; inputs: Record<string, unknown> }) => ({ recipe: c.recipe, input: c.inputs, clip: c.id }));
    expect(forms.map((f: { clip: string }) => f.clip)).toEqual(ids);
    const { out, seen: all } = await counted(() => call("POST", "/api/forecasts", { forms }));
    expect(matching(all, /^select \* from "clips" where "timeline_id" in/)).toHaveLength(1);
    // the same answer as each clip asked alone
    const alone = [];
    for (const f of forms) alone.push((await call("POST", "/api/forecasts", { forms: [f] })).ms[0]);
    expect(out.ms).toEqual(alone);
  });
});

describe("Undo and Redo (L-1, L-13)", () => {
  it("read the last step alone, not every step kept", async () => {
    const tl = await timeline("zz-test undo");
    for (const name of ["zz-test a", "zz-test b", "zz-test c", "zz-test d", "zz-test e"]) await call("PATCH", `/api/timelines/${tl}`, { name });
    const { seen: all } = await counted(() => call("POST", `/api/timelines/${tl}/undo`));
    const reads = matching(all, /^select \* from "timeline_history"/);
    expect(reads.map((r) => r.rows)).toEqual([1]);
    expect((await call("GET", `/api/timelines/${tl}`)).name).toBe("zz-test d");
  });

  it("write the state out once: the items it takes back out of the bin are read from the step as kept", async () => {
    const tl = await timeline("zz-test undo once");
    // clips with long forms, so that the state is most of what is written out
    await call("POST", `/api/timelines/${tl}/plan`, { recipe: "h3.video", clips: Array.from({ length: 6 }, (_, k) => ({ description: `zz-test ${k} ${"words ".repeat(500)}` })) });
    const binned = await video();
    const [first] = await t.db.selectFrom("clips").select("id").where("timeline_id", "=", tl).orderBy("position").execute();
    await t.db.insertInto("takes").values({ id: newId(), clip_id: first!.id, asset_id: binned.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, created_at: now() }).execute();
    await call("PATCH", `/api/timelines/${tl}`, { name: "zz-test renamed" });
    // the take's video binned since the step was kept: Undo takes it back out
    await t.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", binned.id).execute();
    const step = await t.db.selectFrom("timeline_history").select("snapshot").where("timeline_id", "=", tl).orderBy("seq", "desc").limit(1).executeTakeFirstOrThrow();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      await call("POST", `/api/timelines/${tl}/undo`);
      const written = stringify.mock.results.reduce((n, r) => n + (typeof r.value === "string" ? r.value.length : 0), 0);
      // the state kept for Redo, written out once; twice before (a second time for the bin's check)
      expect(written).toBeLessThan(step.snapshot.length * 1.5);
    } finally {
      stringify.mockRestore();
    }
    expect((await t.db.selectFrom("assets").select("deleted_at").where("id", "=", binned.id).executeTakeFirstOrThrow()).deleted_at).toBeNull();
  });
});

describe("the sweep's reading of the Undo steps (M-7)", () => {
  const snapshotNaming = (tl: string, asset: string | null) => JSON.stringify({ timeline: { id: tl }, clips: [], takes: asset ? [{ id: "t", clip_id: "c", asset_id: asset }] : [] });
  async function steps(tl: string, n: number, naming: string | null = null) {
    await t.db.insertInto("timeline_history").values(Array.from({ length: n }, (_, k) => ({ id: newId(), timeline_id: tl, seq: k + 1, label: "zz-test", snapshot: snapshotNaming(tl, k === n - 1 ? naming : null), created_at: now() }))).execute();
  }

  it("reads each step once a sweep, not once in each of its transactions", async () => {
    const tl = await timeline("zz-test sweep");
    await steps(tl, 30);
    const { seen: all } = await counted(() => sweep(t.db, t.services.storage));
    const read = matching(all, /^select "id", "snapshot" from "timeline_history"/).reduce((n, s) => n + s.rows, 0);
    expect(read).toBe(30);
  });

  it("lets the server in between its pages, and gives what inUse reads in a transaction", async () => {
    const tl = await timeline("zz-test pages ahead");
    const named = newId();
    await steps(tl, 70, named);
    const { out, inBetween } = await letsIn(() => undoNamed(t.db));
    expect(inBetween).toBe(true);
    expect(out.read.size).toBe(70);
    expect(out.ids.has(named)).toBe(true);
    const ahead = await inUse(t.db, { undo: out });
    const inTurn = await inUse(t.db, { undo: true });
    expect([...ahead].sort()).toEqual([...inTurn].sort());
  });

  it("still reads a step kept after the pages were read", async () => {
    const tl = await timeline("zz-test kept since");
    await steps(tl, 3);
    const ahead = await undoNamed(t.db);
    const late = newId();
    await t.db.insertInto("timeline_future").values({ id: newId(), timeline_id: tl, seq: 1, label: "zz-test", snapshot: snapshotNaming(tl, late), created_at: now() }).execute();
    expect((await inUse(t.db, { undo: ahead })).get(late)).toBe("a timeline's Undo");
  });

  it("runs at start only when told: the server's start runs it after it listens", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    const old = newId();
    await db.insertInto("assets").values(newAssetRow({
      id: old, kind: "image", origin: "generated", name: "zz-test", file_key: `assets/${old}.png`, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1,
      duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, created_at: new Date(Date.now() - UNKEPT_MS - 60_000).toISOString(),
    })).execute();
    const s = await createServices(db, "sqlite", new LocalStorage(mkdtempSync(join(tmpdir(), "afflatus-test-"))), FAST, { precompute: false, firstSweepMs: 60_000 });
    try {
      await new Promise((r) => setTimeout(r, 100));
      // not swept yet: the unkept result made a day ago is still out of the bin
      expect((await db.selectFrom("assets").select("deleted_at").where("id", "=", old).executeTakeFirstOrThrow()).deleted_at).toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe("clips added several at once (L-14)", () => {
  it("move the clips after them once, writing only the places that change", async () => {
    const tl = await timeline("zz-test renumber");
    await planned(tl, 3, "zz-test first");
    const { seen: all } = await counted(() => planned(tl, 4, "zz-test more"));
    // appended at the end: no clip before them moves
    expect(matching(all, /^update "clips" set "position"/)).toHaveLength(0);
    expect((await order(tl)).map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("a move writes the places that change, not every clip's", async () => {
    const tl = await timeline("zz-test move");
    const [a, b, c, d, e] = (await planned(tl, 5)) as [string, string, string, string, string];
    const { seen: all } = await counted(() => call("PATCH", `/api/clips/${e}`, { after: a }));
    expect(matching(all, /^update "clips" set "position"/)).toHaveLength(4);
    expect((await order(tl)).map((x) => x.id)).toEqual([a, e, b, c, d]);
  });
});

describe("several jobs queued together (L-15)", () => {
  const INPUT = { prompt: "zz-test a cat", checkpoint: CHECKPOINT };

  it("are written in one transaction, in order, each able to wait for one before it", async () => {
    const { out: ids, seen: all } = await counted(() => t.services.queue.enqueueAll(async (ask) => {
      const first = await ask.render("sdxl.text-to-picture", INPUT, { label: "zz-test one" });
      await ask.cut({ asset: "nope", startMs: 0, endMs: 1000, action: "copy" }, "zz-test after", { dependsOn: first });
      await ask.render("sdxl.text-to-picture", INPUT, { label: "zz-test two" });
    }));
    expect(ids).toHaveLength(3);
    expect(matching(all, /^begin/i)).toHaveLength(1);
    const rows = await t.db.selectFrom("jobs").select(["id", "label", "depends_on", "status"]).where("id", "in", ids).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(ids.map((id) => byId.get(id)!.label)).toEqual(["zz-test one", "zz-test after", "zz-test two"]);
    expect(byId.get(ids[1]!)!.depends_on).toBe(ids[0]);
  });

  it("are all queued or none: one refused part way queues nothing, and says why", async () => {
    const before = (await t.db.selectFrom("jobs").select("id").execute()).length;
    await expect(t.services.queue.enqueueAll(async (ask) => {
      await ask.render("sdxl.text-to-picture", INPUT, { label: "zz-test fine" });
      await ask.render("sdxl.text-to-picture", { ...INPUT, prompt: 5 }, { label: "zz-test refused" });
    })).rejects.toThrow();
    expect((await t.db.selectFrom("jobs").select("id").execute()).length).toBe(before);
  });
});

describe("a timeline as sent to the editor (L-4)", () => {
  it("names each clip's playing take by its id, the take itself once, among its takes", async () => {
    const tl = await timeline("zz-test sent");
    const [c] = await planned(tl, 1);
    const asset = await video();
    const take = newId();
    await t.db.insertInto("takes").values({ id: take, clip_id: c!, asset_id: asset.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, created_at: now() }).execute();
    await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", c!).execute();
    const res = await get(t.app, `/api/timelines/${tl}`);
    const sent = res.json();
    expect(sent.clips[0].take).toBe(take);
    expect(sent.clips[0].takes.map((x: { id: string }) => x.id)).toEqual([take]);
    // the take's video is described once, in its takes
    expect(res.body.split(`"id":"${asset.id}"`).length - 1).toBe(1);
    // as the server's own view has it
    expect((await t.services.timelines.view(tl)).clips[0]!.take!.id).toBe(take);
  });
});

describe("the music ducked under speech (L-5)", () => {
  const asset = (id: string) => ({ id, kind: "audio" }) as AssetRow;
  const laid = (sound: AssetRow, atMs: number, lengthMs: number): Laid => ({
    p: { clip: { kind: "video", sound: "file", volume: 100 }, sound, active: null, takes: [], still: null, pictures: [] } as unknown as Laid["p"], index: 0, atMs, lengthMs,
  });

  it("reads each sound with the row it has, a few at once, once each", async () => {
    const [a, b, c] = [asset("a"), asset("b"), asset("c")];
    const asked: Array<{ id: string; row?: AssetRow }> = [];
    let open = 0;
    let most = 0;
    const speechOf = async (id: string, row?: AssetRow) => {
      asked.push({ id, row });
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      // a speaks all along, b never, c in its second half
      return { rate: 10, speech: id === "a" ? Array(10).fill(-10) : id === "b" ? Array(10).fill(-60) : [...Array(5).fill(-60), ...Array(5).fill(-10)] };
    };
    const curve = await duckCurve([laid(a, 0, 1000), laid(b, 1000, 1000), laid(c, 2000, 1000), laid(a, 3000, 1000)], speechOf, 12);
    expect(asked.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    expect(asked.every((x) => x.row?.id === x.id)).toBe(true);
    expect(most).toBeGreaterThan(1);
    // the same curve as read one after the other: down under a, up under b, down for c's second half and a again
    const low = 10 ** (-12 / 20);
    const at = (ms: number) => curve.gains[Math.floor((ms / 1000) * curve.rate)]!;
    expect(at(900)).toBeLessThan(low + 0.05);
    expect(at(1950)).toBeGreaterThan(0.6);
    expect(at(2950)).toBeLessThan(low + 0.05);
    expect(at(3950)).toBeLessThan(low + 0.05);
  });
});

describe("the first fold after an update (L-16)", () => {
  const NOW = Date.parse("2026-10-22T12:00:00.000Z");
  const DAY = 24 * 60 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  async function seeded(): Promise<Db> {
    const db = openSqlite(":memory:");
    await migrate(db);
    const sessions = Array.from({ length: 250 }, (_, k) => {
      const from = NOW - (k + 3) * DAY;
      return { id: `zz-${String(k).padStart(3, "0")}`, machine_id: `rp-${k % 3}`, pod: `p${k}`, rate: 0.6, started_at: iso(from), ended_at: iso(from + 60 * 60_000), seen_at: null, gpu: "NVIDIA A40", up_at: iso(from + 3 * 60_000), idle_minutes: 10 };
    });
    for (let i = 0; i < sessions.length; i += 100) await db.insertInto("rent_sessions").values(sessions.slice(i, i + 100)).execute();
    return db;
  }
  const splits = (db: Db) => db.selectFrom("rent_sessions").select(["id", "split", "split_until"]).orderBy("id").execute();

  it("splits the sessions a hundred at a time, the server let in between, each split as one pass gives it", async () => {
    const db = await seeded();
    const once = await seeded();
    try {
      const { seen: all, out } = await counted(() => letsIn(() => fold(db, 90, NOW)));
      expect(out.inBetween).toBe(true);
      // three turns of sessions, and the fold's own transaction
      expect(matching(all, /^begin/i).length).toBeGreaterThanOrEqual(4);
      await freezeSplits(once, NOW - DAY);
      const got = await splits(db);
      expect(got.every((s) => s.split !== null && s.split_until === null)).toBe(true);
      expect(got).toEqual(await splits(once));
    } finally {
      await db.destroy();
      await once.destroy();
    }
  });
});

