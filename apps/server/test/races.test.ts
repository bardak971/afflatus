import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { newId, openSqlite, OWNER } from "../src/db";
import { LocalStorage } from "../src/storage";
import { BIN_MS, sweep } from "../src/sweep";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Two requests at once on the same thing. With the database in its worker thread, another request runs between any two
 * statements of a route: what a route reads and then writes from must not be changed in between, or one of the two
 * changes is lost. Each test fires the two together, with the worker on whatever the default, and checks both landed.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp({ db: openSqlite(":memory:", { worker: true }) });
});
afterEach(() => t.close());

const RECIPE = "sdxl.text-to-picture";
const put = (url: string, payload: unknown) => t.app.inject({ method: "PUT", url, payload: payload as object });
const patch = (url: string, payload: unknown) => t.app.inject({ method: "PATCH", url, payload: payload as object });
const del = (url: string) => t.app.inject({ method: "DELETE", url });
/** Tries a few times: a race lost once in a while is lost all the same. */
const ROUNDS = 8;

describe("a draft saved twice at once", () => {
  it("not written yet: both saves land, neither answers 404 nor fails on the row the other wrote", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE })).json();
      const [a, b] = await Promise.all([
        put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { prompt: "zz-test a lighthouse" } } }),
        put(`/api/drafts/${d.id}`, { name: "zz-test lighthouse" }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect((await get(t.app, `/api/drafts/${d.id}`)).json()).toMatchObject({ name: "zz-test lighthouse", forms: { [RECIPE]: { prompt: "zz-test a lighthouse" } } });
    }
  });

  it("written: a save of one field does not put back the other field as it was before the other save", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "zz-test a harbour" } } })).json();
      await Promise.all([
        put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { prompt: "zz-test a harbour at dusk" } } }),
        put(`/api/drafts/${d.id}`, { chat: [{ role: "user", text: "zz-test" }] }),
      ]);
      const now = (await get(t.app, `/api/drafts/${d.id}`)).json();
      expect(now.forms[RECIPE].prompt).toBe("zz-test a harbour at dusk");
      expect(now.chat).toHaveLength(1);
    }
  });
});

describe("timelines", () => {
  const positions = async (id: string) => (await t.db.selectFrom("clips").select(["id", "position"]).where("timeline_id", "=", id).orderBy("position").execute());

  it("new ones made at once without a name are numbered apart", async () => {
    const made = await Promise.all(Array.from({ length: 4 }, () => post(t.app, "/api/timelines", {})));
    expect(new Set(made.map((r) => r.json().name)).size).toBe(4);
  });

  it("clips added at once each get a place of their own, in the order of the timeline", async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test" })).json();
    await Promise.all(Array.from({ length: 5 }, () => post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: RECIPE })));
    expect((await positions(tl.id)).map((c) => c.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("a clip moved while another is added, and a scene planned at the same time: every clip keeps a place of its own", async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test" })).json();
    for (let i = 0; i < 3; i++) await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: RECIPE });
    for (let i = 0; i < ROUNDS; i++) {
      const [first, , last] = await positions(tl.id);
      await Promise.all([
        patch(`/api/clips/${first!.id}`, { after: last!.id }),
        post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: RECIPE }),
        post(t.app, `/api/timelines/${tl.id}/plan`, { recipe: RECIPE, clips: [{ prompt: "zz-test one" }, { prompt: "zz-test two" }] }),
      ]);
      const all = await positions(tl.id);
      expect(all.map((c) => c.position)).toEqual(all.map((_, k) => k));
    }
  });
});

describe("settings changed from two places at once", () => {
  it("two pinned projects archived at once both leave the pins", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const a = (await post(t.app, "/api/projects", { name: `zz-test a${i}` })).json();
      const b = (await post(t.app, "/api/projects", { name: `zz-test b${i}` })).json();
      await put("/api/settings", { pinnedProjects: [a.id, b.id] });
      await Promise.all([patch(`/api/projects/${a.id}`, { archived: true }), patch(`/api/projects/${b.id}`, { archived: true })]);
      expect((await get(t.app, "/api/settings")).json().pinnedProjects).toEqual([]);
    }
  });
});

describe("the Prompt kit", () => {
  it("a person renamed while their pictures change keeps both changes", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const p = (await post(t.app, "/api/entities", { kind: "person", name: "zz-test", def: { tags: "a" } })).json();
      await Promise.all([put(`/api/entities/${p.id}`, { def: { tags: "b" } }), put(`/api/entities/${p.id}`, { name: "zz-test renamed" })]);
      const now = (await get(t.app, "/api/entities?kind=person")).json().items.find((e: { id: string }) => e.id === p.id);
      expect(now).toMatchObject({ name: "zz-test renamed", def: { tags: "b" } });
    }
  });

  it("two people deleted at once both leave the drafts' looks", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const [a, b] = await Promise.all([1, 2].map(async (n) => (await post(t.app, "/api/entities", { kind: "person", name: `zz-test ${n}` })).json()));
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, look: { cast: [{ id: a.id }, { id: b.id }], snippets: [] } })).json();
      await Promise.all([del(`/api/entities/${a.id}`), del(`/api/entities/${b.id}`)]);
      expect((await get(t.app, `/api/drafts/${d.id}`)).json().look.cast).toEqual([]);
    }
  });
});

describe("folders", () => {
  it("two folders moved into each other at once: one move is refused, never a loop", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const [a, b] = await Promise.all([1, 2].map(async (n) => (await post(t.app, "/api/folders", { name: `zz-test ${i}.${n}` })).json()));
      await Promise.all([patch(`/api/folders/${a.id}`, { parentId: b.id }), patch(`/api/folders/${b.id}`, { parentId: a.id })]);
      const rows = await t.db.selectFrom("folders").select(["id", "parent_id"]).where("id", "in", [a.id, b.id]).execute();
      expect(rows.filter((r) => r.parent_id).length).toBeLessThan(2);
    }
  });
});

describe("the bin", () => {
  const HOUR = 60 * 60_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  async function binned(binnedAgo: number): Promise<string> {
    const id = newId();
    const key = `assets/${id}.png`;
    await t.services.storage.put(key, new Uint8Array([1]));
    await t.db.insertInto("assets").values({
      id, owner_id: OWNER, kind: "image", origin: "generated", name: "zz-test", file_key: key, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1,
      duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, countdown_from: null, deleted_at: ago(binnedAgo), created_at: ago(binnedAgo),
    }).execute();
    return id;
  }
  const there = async (id: string) => Boolean(await t.db.selectFrom("assets").select("id").where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst());

  const gone = async (id: string) => !(await t.db.selectFrom("assets").select("id").where("id", "=", id).executeTakeFirst());
  /** The bin is being erased (its first item is gone): the last items are put back meanwhile. */
  async function putBackWhileErasing(ids: string[], erasing: Promise<unknown>) {
    await until(() => gone(ids[0]!), 10_000);
    const late = ids.slice(-3);
    const back = await Promise.all(late.map((id) => post(t.app, `/api/assets/${id}/restore`, {})));
    await erasing;
    for (const [k, r] of back.entries()) if (r.statusCode === 200) expect(await there(late[k]!)).toBe(true);
  }

  it("an item put back while the bin is emptied is either put back and kept, or erased and not said to be back", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await binned(HOUR));
    await putBackWhileErasing(ids, post(t.app, "/api/storage/empty-bin", {}));
  });

  it("the same with the hourly sweep: an item put back while it erases what was in the bin a week stays", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await binned(BIN_MS + HOUR));
    await putBackWhileErasing(ids, sweep(t.db, t.services.storage));
  });
});

describe("files written at once under one name", () => {
  it("all land: the last one written is the file, and none fails on the other's rename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-race-"));
    try {
      const storage = new LocalStorage(dir);
      const bytes = (n: number) => new Uint8Array(64 * 1024).fill(n);
      await Promise.all(Array.from({ length: 24 }, (_, n) => storage.put("assets/zz/zz-test.png", bytes(n))));
      expect((await storage.get("assets/zz/zz-test.png")).length).toBe(64 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a render's end", () => {
  let fake: FakeComfy;
  beforeEach(async () => {
    fake = await makeFake();
    await t.close();
    t = await makeApp({ db: openSqlite(":memory:", { worker: true }), comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await fake.close().catch(() => {});
  });

  it("once its job reads done: its time is on record, and ComfyUI's memory can be freed", async () => {
    for (let i = 0; i < 3; i++) {
      const id = (await post(t.app, "/api/jobs", job({ prompt: `zz-test ${i}` }))).json().ids[0] as string;
      await until(() => fake.prompts.size === i + 1);
      // what a screen reads the moment it is told the queue changed: the job, its record and a free asked at once
      const looks: Array<Promise<unknown>> = [];
      const seen = new Promise<{ stats: unknown; free: number }>((done) => {
        const look = () => {
          const status = t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow();
          const stats = t.db.selectFrom("render_stats").select("id").where("id", "=", id).executeTakeFirst();
          const free = t.services.queue.freeMemory().then(() => 200, () => 400);
          looks.push(Promise.all([status, stats, free]).then(([s, r, f]) => {
            if (s.status !== "done") return;
            t.services.queue.events.off("queue", look);
            done({ stats: r, free: f });
          }));
        };
        t.services.queue.events.on("queue", look);
      });
      complete(fake, [...fake.prompts.keys()].at(-1)!);
      const { stats, free } = await seen;
      expect(stats).toBeDefined();
      expect(free).toBe(200);
      await t.services.queue.idle();
      await Promise.all(looks);
    }
  });
});
