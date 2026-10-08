import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

type Page = { items: Array<{ id: string }>; next: string | null; prev: string | null };

/** Items made one a minute apart, newest last; every third shares the moment of the one before (ids break the tie). */
async function addAssets(n: number, of: (i: number) => { kind?: "image" | "audio"; name?: string } = () => ({})): Promise<string[]> {
  const ids: string[] = [];
  // recent: a result nobody kept goes to the bin after a day
  let at = Date.now() - 3_600_000;
  for (let i = 0; i < n; i++) {
    if (i % 3) at += 60_000;
    const id = newId();
    const { kind = "image", name = "" } = of(i);
    await t.db.insertInto("assets").values({
      id, owner_id: OWNER, kind, origin: "generated", name, file_key: `assets/${id}`, thumb_key: null, mime: kind === "audio" ? "audio/mpeg" : "image/png",
      bytes: 1, width: 1, height: 1, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
      kept_at: null, deleted_at: null, created_at: new Date(at).toISOString(),
    }).execute();
    ids.push(id);
  }
  return ids;
}

/** Every page down from the top, then every page back up from the last one by its `prev`. */
async function walk(query: string): Promise<{ down: Page[]; up: Page[] }> {
  const at = async (cursor: string) => (await get(t.app, `/api/assets?limit=3${query}${cursor}`)).json() as Page;
  const down = [await at("")];
  while (down.at(-1)!.next) down.push(await at(`&after=${encodeURIComponent(down.at(-1)!.next!)}`));
  const up: Page[] = [];
  let prev = down.at(-1)!.prev;
  while (prev) {
    const page = await at(`&before=${encodeURIComponent(prev)}`);
    up.unshift(page);
    prev = page.prev;
  }
  return { down, up };
}
const ids = (pages: Page[]) => pages.flatMap((p) => p.items.map((i) => i.id));

describe("paging the library both ways", () => {
  it("gives the same pages going up as going down, in the list's order", async () => {
    await addAssets(11);
    const { down, up } = await walk("");
    const order = await t.db.selectFrom("assets").select("id").orderBy("created_at", "desc").orderBy("id", "desc").execute();
    expect(ids(down)).toEqual(order.map((r) => r.id));
    expect(ids(down)).toHaveLength(11);
    // the top page has nothing above; every page after it does
    expect(down[0]!.prev).toBeNull();
    expect(down.slice(1).every((p) => p.prev)).toBe(true);
    // the pages above the last one, read upwards, are the ones read downwards
    expect(up.map((p) => p.items.map((i) => i.id))).toEqual(down.slice(0, -1).map((p) => p.items.map((i) => i.id)));
    // a page read upwards says what is below it, like one read downwards
    expect(up.map((p) => p.next)).toEqual(down.slice(0, -1).map((p) => p.next));
  });

  it("keeps the filters going up", async () => {
    await addAssets(14, (i) => ({ kind: i % 2 ? "audio" : "image" }));
    const { down, up } = await walk("&kind=audio");
    expect(ids(down)).toHaveLength(7);
    expect(up.map((p) => p.items.map((i) => i.id))).toEqual(down.slice(0, -1).map((p) => p.items.map((i) => i.id)));
    const audio = new Set((await t.db.selectFrom("assets").select("id").where("kind", "=", "audio").execute()).map((r) => r.id));
    expect(ids(up).every((id) => audio.has(id))).toBe(true);
  });

  it("pages a search both ways too", async () => {
    await addAssets(12, (i) => ({ name: i % 3 ? `sunset ${i}` : `harbour ${i}` }));
    const { down, up } = await walk("&q=sunset");
    expect(ids(down)).toHaveLength(8);
    expect(down[0]!.prev).toBeNull();
    expect(up.map((p) => p.items.map((i) => i.id))).toEqual(down.slice(0, -1).map((p) => p.items.map((i) => i.id)));
    expect(up[0]!.prev).toBeNull();
  });
});
