import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openSqlite, type Db } from "../src/db";
import { OUTSIDE_STALE_MS, PodOutside } from "../src/podOutside";

/**
 * A pod's time at work queued in its ComfyUI from outside Afflatus (podOutside.ts), as Queue › Costs reads it: a stretch per
 * run of such work while its session is open, closed where its end was seen, or at its last sight where nothing more is known.
 */

const S = 1000;
const T0 = Date.parse("2026-10-16T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let db: Db;
let now: number;
const make = () => new PodOutside(db, () => now);
const rows = async () => (await db.selectFrom("pod_outside").selectAll().orderBy("started_at").execute()).map((r) => ({ session: r.session_id, machine: r.machine_id, from: r.started_at, seen: r.seen_at, to: r.ended_at }));
const running = { running: 1, pending: 0 };
const none = { running: 0, pending: 0 };

beforeEach(async () => {
  db = openSqlite(":memory:");
  await migrate(db);
  now = T0;
  await db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp", pod: "p", rate: 0.2, started_at: iso(T0 - 600 * S), ended_at: null, seen_at: iso(T0), gpu: "NVIDIA GeForce RTX 3070", up_at: iso(T0 - 300 * S), idle_minutes: 10, busy_at: null }).execute();
});
afterEach(async () => {
  await db.destroy();
});

describe("a pod's work from outside Afflatus", () => {
  it("a stretch from the read that first found it running to the read that found it over; its last sight kept as it runs", async () => {
    const o = make();
    o.note("rp", running);
    now = T0 + 20 * S;
    o.note("rp", { running: 1, pending: 2 });
    await o.settled();
    expect(o.timing("rp")).toBe(true);
    // its last sight written while it runs (what a restart closes it at)
    expect(await rows()).toEqual([{ session: "s1", machine: "rp", from: iso(T0), seen: iso(T0 + 20 * S), to: null }]);
    now = T0 + 240 * S;
    o.note("rp", running);
    now = T0 + 250 * S;
    o.note("rp", none);
    await o.settled();
    expect(o.timing("rp")).toBe(false);
    expect(await rows()).toEqual([{ session: "s1", machine: "rp", from: iso(T0), seen: iso(T0 + 250 * S), to: iso(T0 + 250 * S) }]);
    // the next run of it is a stretch of its own
    now = T0 + 400 * S;
    o.note("rp", running);
    now = T0 + 410 * S;
    o.note("rp", none);
    await o.settled();
    expect((await rows()).map((r) => [r.from, r.to])).toEqual([[iso(T0), iso(T0 + 250 * S)], [iso(T0 + 400 * S), iso(T0 + 410 * S)]]);
  });

  it("only prompts running count: one waiting holds no GPU", async () => {
    const o = make();
    o.note("rp", { running: 0, pending: 3 });
    await o.settled();
    expect(await rows()).toEqual([]);
    o.note("rp", running);
    now = T0 + 30 * S;
    // the running one done, the rest still waiting: over
    o.note("rp", { running: 0, pending: 2 });
    await o.settled();
    expect((await rows()).map((r) => [r.from, r.to])).toEqual([[iso(T0), iso(T0 + 30 * S)]]);
  });

  it("ends at its last sight when its ComfyUI could not be read, or its end was read only long after", async () => {
    const o = make();
    o.note("rp", running);
    now = T0 + 60 * S;
    o.note("rp", running);
    now = T0 + 70 * S;
    // not read (the pod gone, its ComfyUI down): nothing is known past its last sight
    o.note("rp", null);
    await o.settled();
    expect((await rows())[0]).toMatchObject({ seen: iso(T0 + 60 * S), to: iso(T0 + 60 * S) });
    now = T0 + 100 * S;
    o.note("rp", running);
    now = T0 + 100 * S + OUTSIDE_STALE_MS + S;
    o.note("rp", none);
    await o.settled();
    expect((await rows())[1]).toMatchObject({ from: iso(T0 + 100 * S), to: iso(T0 + 100 * S) });
  });

  it("a stretch left open by a restart of Afflatus is closed at its last sight; the work still running is a new stretch", async () => {
    const before = make();
    before.note("rp", running);
    now = T0 + 45 * S;
    before.note("rp", running);
    // seen again 5 s later: not written yet (its last sight is written every 15 s), and lost with the restart
    now = T0 + 50 * S;
    before.note("rp", running);
    await before.settled();
    now = T0 + 300 * S;
    const after = make();
    await after.settled();
    expect(await rows()).toEqual([{ session: "s1", machine: "rp", from: iso(T0), seen: iso(T0 + 45 * S), to: iso(T0 + 45 * S) }]);
    after.note("rp", running);
    await after.settled();
    expect((await rows()).map((r) => [r.from, r.to])).toEqual([[iso(T0), iso(T0 + 45 * S)], [iso(T0 + 300 * S), null]]);
  });

  it("a stretch whose session ended (its pod stopped while the work ran, nothing read meanwhile) is closed, not carried into the next run", async () => {
    const o = make();
    o.note("rp", running);
    now = T0 + 20 * S;
    o.note("rp", running);
    await o.settled();
    // the pod stopped, its ComfyUI never read again; started later as a new session, the work found running at once
    await db.updateTable("rent_sessions").set({ ended_at: iso(T0 + 60 * S) }).where("id", "=", "s1").execute();
    await db.insertInto("rent_sessions").values({ id: "s2", machine_id: "rp", pod: "p", rate: 0.2, started_at: iso(T0 + 3600 * S), ended_at: null, seen_at: iso(T0 + 3600 * S), gpu: null, up_at: null, idle_minutes: 10, busy_at: null }).execute();
    now = T0 + 3700 * S;
    o.note("rp", running);
    await o.settled();
    expect(await rows()).toEqual([
      { session: "s1", machine: "rp", from: iso(T0), seen: iso(T0 + 20 * S), to: iso(T0 + 20 * S) },
      { session: "s2", machine: "rp", from: iso(T0 + 3700 * S), seen: iso(T0 + 3700 * S), to: null },
    ]);
  });

  it("is not kept for a machine with no open session (this PC's own, a pod not billed), and starts no earlier than its session", async () => {
    const o = make();
    o.note("m1", running);
    await o.settled();
    expect(o.timing("m1")).toBe(false);
    await db.updateTable("rent_sessions").set({ ended_at: iso(T0 - 60 * S) }).execute();
    o.note("rp", running);
    await o.settled();
    expect(await rows()).toEqual([]);
    // a session whose start was set after the read (its start said by RunPod a moment late): the stretch starts with it
    await db.insertInto("rent_sessions").values({ id: "s2", machine_id: "rp", pod: "p", rate: 0.2, started_at: iso(T0 + 5 * S), ended_at: null, seen_at: iso(T0), gpu: null, up_at: null, idle_minutes: 10, busy_at: null }).execute();
    o.note("rp", running);
    await o.settled();
    expect(await rows()).toEqual([{ session: "s2", machine: "rp", from: iso(T0 + 5 * S), seen: iso(T0 + 5 * S), to: null }]);
  });
});
