import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { onPostgres } from "./dialect";

const migration: Migration = {
  async up(db) {
    // how a rendered video's own part looks (JSON), in its own column: a timeline reads it without parsing resolved
    await db.schema.alterTable("generations").addColumn("measure", "text").execute();
    // the renders that have one, taken out of resolved in one statement (the like skips the parse of every other row)
    if (onPostgres(db)) await sql`update generations set measure = (resolved::json -> 'measure')::text where resolved like '%"measure":%' and resolved::json -> 'measure' is not null`.execute(db);
    else await sql`update generations set measure = json_extract(resolved, '$.measure') where resolved like '%"measure":%' and json_extract(resolved, '$.measure') is not null`.execute(db);
  },
  async down(db) {
    await db.schema.alterTable("generations").dropColumn("measure").execute();
  },
};
export default migration;
