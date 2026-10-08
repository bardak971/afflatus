import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a project whose root folder was deleted pointed at nothing: its things then land at the top, in the project
    await sql`update projects set folder_id = null where folder_id is not null and folder_id not in (select id from folders)`.execute(db);
  },
  async down() {},
};
export default migration;
