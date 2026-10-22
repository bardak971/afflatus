import type { Family } from "@afflatus/core";
import type { Db } from "./db";
import { sizeOf } from "./fromLink";

/** Where the sizes are kept: a key of the settings table the schema ignores (as the queue's own notes are). */
const KEY = "officialSizes";

/** Below this, what was said is not a model file's size (an error page's): it is asked again. */
const LEAST = 1 << 20;

/** How many sizes are asked at once: a few dozen links, asked once each, without a burst at every start. */
const AT_ONCE = 4;

/**
 * How large each family's official files are (a slot's `get`), by address: what a form's greyed file, Settings › Models and
 * the family picker say beside a file that is not here ("6.9 GB"). Asked once per address, without fetching the file (a
 * HEAD: Hugging Face says the size on its first answer), and kept in the settings table; an address that said nothing is
 * asked again at the next start, not at every page load. Nothing is asked while lookups are off (Settings › Models: "Afflatus
 * never contacts Hugging Face or Civitai"), the sizes kept from before still said; nor where pretend sites stand in (the
 * tests, the demo): no size is said there.
 */
export class OfficialSizes {
  private known: Record<string, number> | null = null;
  private asking: Promise<void> | null = null;
  /** The addresses asked since the start: one that said nothing waits for the next start. */
  private readonly tried = new Set<string>();

  constructor(private readonly db: Db, private readonly families: () => Family[], private readonly lookups: () => Promise<boolean>) {}

  /**
   * The sizes known now (address → bytes), the ones missing asked in the background when lookups are on; `asking` while
   * that is under way, so that the page asks again only then.
   */
  async sizes(): Promise<{ sizes: Record<string, number>; asking: boolean }> {
    const known = await this.read();
    if (!this.asking && this.missing(known).length && (await this.lookups().catch(() => false))) this.asking = this.askMissing().finally(() => (this.asking = null));
    return { sizes: known, asking: Boolean(this.asking) };
  }

  /** The families' official addresses with no size known, not yet asked since the start. */
  private missing(known: Record<string, number>): string[] {
    return [...new Set(this.families().flatMap((f) => f.slots.map((s) => s.get?.url)).filter((u): u is string => Boolean(u)))].filter((u) => !known[u] && !this.tried.has(u));
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
    // one kept from before a refusal was told apart (a gated repository's few bytes) is asked again
    this.known = Object.fromEntries(Object.entries(parsed).filter(([, bytes]) => bytes >= LEAST));
    return this.known;
  }

  private async askMissing(): Promise<void> {
    const known = await this.read();
    const urls = this.missing(known);
    if (!urls.length) return;
    for (const u of urls) this.tried.add(u);
    let found = false;
    for (let i = 0; i < urls.length; i += AT_ONCE) {
      const sizes = await Promise.all(urls.slice(i, i + AT_ONCE).map(async (u) => [u, await sizeOf(u)] as const));
      for (const [u, bytes] of sizes) {
        if (bytes < LEAST) continue;
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
