import type { Family } from "@afflatus/core";
import type { Db } from "./db";
import { sizeOf } from "./fromLink";

/** Where the sizes are kept: a key of the settings table the schema ignores (as the queue's own notes are). */
const KEY = "officialSizes";

/** How many sizes are asked at once: a few dozen links, asked once each, without a burst at every start. */
const AT_ONCE = 4;

/**
 * How large each family's official files are (a slot's `get`), by address: what a form's greyed file, Settings › Models and
 * the family picker say beside a file that is not here ("6.9 GB"). Asked once per address, without fetching the file (a
 * HEAD: Hugging Face says the size on its first answer), and kept in the settings table; an address that said nothing is
 * asked again at the next start. Nothing is asked where pretend sites stand in (the tests, the demo): no size is said there.
 */
export class OfficialSizes {
  private known: Record<string, number> | null = null;
  private asking: Promise<void> | null = null;

  constructor(private readonly db: Db, private readonly families: () => Family[]) {}

  /** The sizes known now (address → bytes), the ones missing asked in the background. */
  async sizes(): Promise<Record<string, number>> {
    const known = await this.read();
    this.asking ??= this.askMissing().finally(() => (this.asking = null));
    return known;
  }

  private async read(): Promise<Record<string, number>> {
    if (this.known) return this.known;
    const row = await this.db.selectFrom("settings").select("value").where("key", "=", KEY).executeTakeFirst().catch(() => undefined);
    let parsed: Record<string, number> = {};
    try {
      parsed = row ? (JSON.parse(row.value) as Record<string, number>) : {};
    } catch {
      // a value that is not JSON is asked again
    }
    this.known = parsed;
    return parsed;
  }

  private async askMissing(): Promise<void> {
    const known = await this.read();
    const urls = [...new Set(this.families().flatMap((f) => f.slots.map((s) => s.get?.url)).filter((u): u is string => Boolean(u)))].filter((u) => !known[u]);
    if (!urls.length) return;
    let found = false;
    for (let i = 0; i < urls.length; i += AT_ONCE) {
      const sizes = await Promise.all(urls.slice(i, i + AT_ONCE).map(async (u) => [u, await sizeOf(u)] as const));
      for (const [u, bytes] of sizes) {
        if (bytes <= 0) continue;
        known[u] = bytes;
        found = true;
      }
    }
    if (!found) return;
    const value = JSON.stringify(known);
    const now = new Date().toISOString();
    await this.db.insertInto("settings").values({ key: KEY, value, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now })).execute();
  }
}
