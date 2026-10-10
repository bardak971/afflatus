/**
 * Checks that the "Render times" summaries read from the days' digests (render_digests) are the same, to the byte, as
 * the same summaries worked out from the rows alone, on a copy of a real database. The database given is only read:
 * it is copied first (VACUUM INTO, a temporary file), and the copy is brought up to date and checked.
 *   npx tsx scripts/check-render-digests.ts <afflatus.db>
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openSqlite } from "../apps/server/src/db";
import { Registry } from "../apps/server/src/registry";
import { digestDays, summary } from "../apps/server/src/renders";

const [source] = process.argv.slice(2);
if (!source) {
  console.error("usage: npx tsx scripts/check-render-digests.ts <afflatus.db>");
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "afflatus-digests-"));
const copy = join(dir, "afflatus.db");
const original = new DatabaseSync(source, { readOnly: true });
original.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
original.close();

const db = openSqlite(copy);
let failed = false;
try {
  await migrate(db);
  await digestDays(db, Date.now());
  const registry = new Registry(db);
  await registry.load();
  const when = Date.now();
  const DAY = 86_400_000;
  const periods: Array<Parameters<typeof summary>[2]> = ["day", "week", "month", "all", { from: when - 3 * DAY, to: when - DAY }, { from: when - 40 * DAY, to: when - 10 * DAY }];
  const timed = async (p: Parameters<typeof summary>[2]) => {
    const t = performance.now();
    const text = JSON.stringify(await summary(db, registry, p, 90, when));
    return { text, ms: performance.now() - t };
  };
  const kept = await db.selectFrom("render_digests").selectAll().execute();
  const digested = [];
  for (const p of periods) digested.push(await timed(p));
  await db.deleteFrom("render_digests").execute();
  for (const [i, p] of periods.entries()) {
    const rows = await timed(p);
    const name = typeof p === "string" ? p : `${new Date(p.from).toISOString().slice(0, 10)}..${new Date(p.to).toISOString().slice(0, 10)}`;
    const same = rows.text === digested[i]!.text;
    if (!same) failed = true;
    console.log(`${name.padEnd(24)} ${same ? "same" : "DIFFERENT"}  ${digested[i]!.text.length} bytes  digests ${digested[i]!.ms.toFixed(1)} ms, rows ${rows.ms.toFixed(1)} ms`);
  }
  console.log(`${kept.length} days digested`);
} finally {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
