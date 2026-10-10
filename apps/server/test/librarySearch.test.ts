import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
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
/** An item straight in the table, `n` minutes into 2025, made from a prompt when one is given. */
const item = (n: number, name: string, prompt?: string) => {
  const id = newId();
  const gen = prompt ? { id: newId(), owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt }), resolved: "{}", gen_ms: 1, draft_id: null, created_at: at(n) } : null;
  const row = newAssetRow({
    id, kind: "image", origin: gen ? "generated" : "uploaded", name, file_key: `assets/${id}.png`, thumb_key: null, mime: "image/png", bytes: 10, width: 8, height: 8,
    duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: gen?.id ?? null, source_id: null, deleted_at: null, created_at: at(n),
  });
  // kept: a render not kept goes to the bin a day after it was made
  row.kept_at = at(n);
  return { row, gen };
};
const names = async (q: string) => ((await get(t.app, `/api/assets?limit=200&q=${encodeURIComponent(q)}`)).json().items as Array<{ name: string }>).map((i) => i.name);

describe("searching the library", () => {
  it("finds an item older than the newest few thousand, by its name or its prompt, forgiving typos and accents", async () => {
    // the oldest items, then 4 500 newer ones that match none of the words looked for
    const made = [item(0, "zz-test red 42"), item(1, "Café crème"), item(2, "", "a dragon over the harbor at dusk")];
    for (let n = 0; n < 4500; n++) made.push(item(10 + n, `zz-test filler ${n}`, n % 2 ? "a quiet street" : undefined));
    for (let i = 0; i < made.length; i += 300) {
      const part = made.slice(i, i + 300);
      const gens = part.flatMap((m) => (m.gen ? [m.gen] : []));
      if (gens.length) await t.db.insertInto("generations").values(gens).execute();
      await t.db.insertInto("assets").values(part.map((m) => m.row)).execute();
    }
    expect(await names("zz-test red 42")).toContain("zz-test red 42");
    expect(await names("cafe creme")).toEqual(["Café crème"]);
    expect(await names("CAFÉ")).toEqual(["Café crème"]);
    // the prompt it was made with, a letter left out
    expect((await names("dragn harbr")).length).toBe(1);
    // what is typed matches nothing
    expect(await names("qqxz")).toEqual([]);
    // and the newest still come first among many that match
    expect((await names("filler"))[0]).toBe("zz-test filler 4499");
  });
});
