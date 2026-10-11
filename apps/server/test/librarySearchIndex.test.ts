import { fuzzyFilter } from "@afflatus/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, newId, openSqlite, OWNER, type Db } from "../src/db";
import { newAssetRow } from "../src/media";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const at = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString();
/** An item straight in the table, `n` minutes into 2025, made from a form of these texts when one is given. */
const item = (n: number, name: string, form?: Record<string, unknown>) => {
  const id = newId();
  const gen = form ? { id: newId(), owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify(form), resolved: "{}", gen_ms: 1, draft_id: null, created_at: at(n) } : null;
  const row = newAssetRow({
    id, kind: "image", origin: gen ? "generated" : "uploaded", name, file_key: `assets/${id}.png`, thumb_key: null, mime: "image/png", bytes: 10, width: 8, height: 8,
    duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: gen?.id ?? null, source_id: null, deleted_at: null, created_at: at(n),
  });
  // kept: a render not kept goes to the bin a day after it was made
  row.kept_at = at(n);
  return { row, gen };
};
type Item = ReturnType<typeof item>;
const write = async (db: Db, made: Item[]) => {
  for (let i = 0; i < made.length; i += 300) {
    const part = made.slice(i, i + 300);
    const gens = part.flatMap((m) => (m.gen ? [m.gen] : []));
    if (gens.length) await db.insertInto("generations").values(gens).execute();
    await db.insertInto("assets").values(part.map((m) => m.row)).execute();
  }
};
/** Every item a search finds, page after page, in its order. */
const found = async (q: string, extra = "") => {
  const ids: string[] = [];
  for (let after = "0"; ;) {
    const page = (await get(t.app, `/api/assets?limit=200&q=${encodeURIComponent(q)}&after=${after}${extra}`)).json() as { items: Array<{ id: string }>; next: string | null };
    ids.push(...page.items.map((i) => i.id));
    if (!page.next) return ids;
    after = page.next;
  }
};
const plain = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * What the search should find, worked out the slow way: the forgiving match over every item of the library (its name and
 * every text of its form), newest first before ranking; only those that hold every word as typed when any does.
 */
const expected = (made: Item[], q: string) => {
  const texts = new Map(made.map((m) => [m.row.id, `${m.row.name} ${m.gen ? Object.values(JSON.parse(m.gen.inputs) as Record<string, unknown>).filter((v) => typeof v === "string").join(" ") : ""}`]));
  const newest = [...made].sort((a, b) => b.row.created_at.localeCompare(a.row.created_at)).map((m) => m.row.id);
  const all = fuzzyFilter(newest, q, (id) => texts.get(id)!);
  const words = plain(q).split(/\s+/).filter(Boolean);
  const held = all.filter((id) => words.every((w) => plain(texts.get(id)!).includes(w)));
  return held.length ? held : all;
};

const VOCAB = ["harbor", "castle", "neon", "forest", "portrait", "rain", "smoke", "garden", "mirror", "train", "sunset", "coffee"];
/** The oldest items, which the newest 4 000 leave out, then 4 300 newer ones made from prompts of a few words. */
const library = () => {
  const made = [
    item(0, "zz-test red 42"),
    item(1, "Café crème"),
    item(2, "", { prompt: "a dragon over the harbor at dusk", negative: "blurry", checkpoint: "illustriousXL.safetensors", steps: 30 }),
    item(3, "Ünïcode Straße"),
  ];
  for (let n = 0; n < 4300; n++) {
    const words = [VOCAB[n % 12], VOCAB[(n * 7) % 12], VOCAB[(n * 5 + 3) % 12]].join(" ");
    made.push(item(10 + n, n % 3 ? "" : `zz-test filler ${n}`, n % 4 ? { prompt: `${words}, detailed`, negative: "lowres" } : undefined));
  }
  return made;
};

describe("the library's search index", () => {
  it("finds what the forgiving match over the whole library finds, in its order: exact, prefix, inside a word, accents, typos, old items", async () => {
    const made = library();
    await write(t.db, made);
    for (const q of ["zz-test red 42", "zz-test red", "drag", "agon", "harb dusk", "cafe creme", "CAFÉ", "crème", "strasse", "straße", "unicode", "dragn harbr", "ilxl", "qqxz", "filler 42", "re", "r", "neon rain", "50%", "\"quoted\""]) {
      expect(await found(q), q).toEqual(expected(made, q));
    }
    // an old item, past the newest 4 000, found by its name and by its prompt
    expect(await found("zz-test red 42")).toContain(made[0]!.row.id);
    expect(await found("dragon harbor")).toEqual([made[2]!.row.id]);
    // and many items that hold the words: the newest first among equals
    expect((await found("filler"))[0]).toBe(made.at(-1)!.row.id);
  });

  it("leaves out letters that only come in order when some item holds the word, as the forgiving match ranks them last", async () => {
    // "train" holds t, r, a, i, n: an item about a train, and one whose letters only come in that order
    const made = [item(0, "zz-test scattered", { prompt: "the rain in a nice place" }), item(1, "zz-test train")];
    await write(t.db, made);
    expect(fuzzyFilter(["zz-test scattered the rain in a nice place", "zz-test train "], "train", (x) => x)).toHaveLength(2);
    expect(await found("train")).toEqual([made[1]!.row.id]);
    // with no item holding it as typed, the letters in order are found, as before
    expect(await found("trn")).toEqual([made[1]!.row.id]);
  });

  it("follows the library: a rename, a form changed, the bin, an erased item or generation", async () => {
    const [a, b] = [item(0, "zz-test lantern"), item(1, "zz-test kettle", { prompt: "a copper teapot" })];
    await write(t.db, [a!, b!]);
    expect(await found("teapot")).toEqual([b!.row.id]);

    const renamed = await t.app.inject({ method: "PATCH", url: `/api/assets/${a!.row.id}`, payload: { name: "zz-test lighthouse" } });
    expect(renamed.statusCode).toBe(200);
    expect(await found("lantern")).toEqual([]);
    expect(await found("lighthouse")).toEqual([a!.row.id]);

    await t.db.updateTable("generations").set({ inputs: JSON.stringify({ prompt: "a silver samovar" }) }).where("id", "=", b!.gen!.id).execute();
    expect(await found("teapot")).toEqual([]);
    expect(await found("samovar")).toEqual([b!.row.id]);

    // in the bin: found there, not in the library
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${a!.row.id}` })).statusCode).toBe(200);
    expect(await found("lighthouse")).toEqual([]);
    expect(await found("lighthouse", "&bin=1")).toEqual([a!.row.id]);

    await t.db.deleteFrom("assets").where("id", "=", a!.row.id).execute();
    await t.db.deleteFrom("generations").where("id", "=", b!.gen!.id).execute();
    expect(await found("samovar")).toEqual([]);
    expect(await found("kettle")).toEqual([b!.row.id]);
    expect((await t.db.selectFrom("asset_words").select("asset_id").execute()).map((r) => r.asset_id)).toEqual([b!.row.id]);
    // and the index holds what its table holds (FTS5 checks its external content itself)
    await sql`insert into asset_words_index (asset_words_index, rank) values ('integrity-check', 1)`.execute(t.db);
  });

  it("answers the same as reading the library, where there is no index (Postgres), for the newest items", async () => {
    const made = library().slice(0, 600);
    await write(t.db, made);
    const queries = ["zz-test red 42", "drag", "cafe creme", "dragn harbr", "neon rain", "qqxz"];
    const indexed = await Promise.all(queries.map((q) => found(q)));
    (t.services as { dbKind: string }).dbKind = "postgres";
    for (const [i, q] of queries.entries()) expect(await found(q), q).toEqual(indexed[i]);
  });
});

describe("migration 0052, the library's search index", () => {
  it("is built for the items there were, and taken away again", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0051_review_indexes");
    const made = [item(0, "zz-test old", { prompt: "a wooden boat", seed: 4 }), item(1, "Café")];
    await write(db, made);
    expect(await migrate(db)).toContain("0052_library_search");
    const words = await db.selectFrom("asset_words").select(["asset_id", "words"]).orderBy("doc").execute();
    expect(words).toEqual([{ asset_id: made[0]!.row.id, words: "zz-test old a wooden boat" }, { asset_id: made[1]!.row.id, words: "Café " }]);
    await migrate(db, "0051_review_indexes");
    await expect(db.selectFrom("asset_words").select("doc").execute()).rejects.toThrow();
    await db.destroy();
  });
});

describe("a search, after the 2026-10-11 review", () => {
  it("takes a control character for a space: a NUL ended the index's phrase early and the search answered 500", async () => {
    const made = [item(0, "zz-test lantern"), item(1, "zz-test kettle")];
    await write(t.db, made);
    const res = await get(t.app, `/api/assets?limit=40&q=${encodeURIComponent("lan\u0000tern")}`);
    expect(res.statusCode).toBe(200);
    expect((await get(t.app, `/api/assets?limit=40&q=${encodeURIComponent("kettle\u0000")}`)).json().items.map((i: { id: string }) => i.id)).toEqual([made[1]!.row.id]);
  });

  it("reads a plain letter as itself in a text of plain letters, and still finds a word typed without its accents", async () => {
    // no item holds "cfe" as typed: the letters in order are looked for, and "Café" has its e only with an accent
    const made = [item(0, "zz-test Café"), item(1, "zz-test zebra"), item(2, "zz-test cafe")];
    await write(t.db, made);
    expect(new Set(await found("cfe"))).toEqual(new Set([made[0]!.row.id, made[2]!.row.id]));
    // a typo of a word with a z: the plain texts without one are not let through, and nothing is found that the
    // forgiving match would not find
    expect(await found("zbra")).toEqual(expected(made, "zbra"));
    expect(await found("zzqx")).toEqual(expected(made, "zzqx"));
  });

  it("keeps a search's ranking for its next pages, and drops it when the library changes", async () => {
    const made = Array.from({ length: 50 }, (_, n) => item(n, `zz-test boat ${n}`));
    await write(t.db, made);
    const first = (await get(t.app, "/api/assets?limit=40&q=boat")).json() as { items: Array<{ id: string }>; next: string | null };
    expect(first.next).toBe("40");
    // a new item straight in the table, which says nothing: the next page follows the ranking the first one read
    const late = item(100, "zz-test boat late");
    await write(t.db, [late]);
    const second = (await get(t.app, "/api/assets?limit=40&q=boat&after=40")).json() as { items: Array<{ id: string }> };
    expect([...first.items, ...second.items].map((i) => i.id)).toHaveLength(50);
    expect(second.items.map((i) => i.id)).not.toContain(late.row.id);
    // the library said changed: the search is read afresh
    t.services.queue.events.emit("library");
    expect(await found("boat")).toContain(late.row.id);
  });
});
