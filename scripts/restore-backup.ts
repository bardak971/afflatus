/**
 * Unpacks a backup zip (Settings → Storage → Back up now) into an empty data folder. Stop Afflatus first.
 *   pnpm restore <backup.zip> <data folder>
 * With Postgres (DATABASE_URL), the zip holds the files only: restore the database with the database's own tools.
 */
import { restoreBackup } from "../apps/server/src/backup";

const [zip, dataDir] = process.argv.slice(2);
if (!zip || !dataDir) {
  console.error("usage: pnpm restore <backup.zip> <data folder>");
  process.exit(2);
}
restoreBackup(zip, dataDir).then(
  (n) => console.log(`${n} files restored into ${dataDir}. Start Afflatus with DATA_DIR pointing there.`),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
