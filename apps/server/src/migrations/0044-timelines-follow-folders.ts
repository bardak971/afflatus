import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a timeline filed in a folder of another project (the folder was moved without it): it goes where its folder is
    await sql`update timelines set project_id = (select f.project_id from folders f where f.id = timelines.folder_id)
      where folder_id is not null and exists (select 1 from folders f where f.id = timelines.folder_id and coalesce(f.project_id, '') <> coalesce(timelines.project_id, ''))`.execute(db);
  },
  async down() {},
};
export default migration;
