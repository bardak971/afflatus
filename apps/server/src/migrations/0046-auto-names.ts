import type { Migration } from "kysely/migration";
import { backfillNames } from "../autoName";

// the results made before renders were named when they were made: the takes after their timeline, clip and take,
// what drafts made after their draft, numbered; a name already given stays (autoName.ts holds the rules)
const migration: Migration = {
  async up(db) {
    await backfillNames(db);
  },
  async down() {},
};
export default migration;
