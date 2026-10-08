import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a take's own take-over point is gone (see leadOf): nothing reads it, every take since wrote 0
    await db.schema.alterTable("takes").dropColumn("lead_ms").execute();
  },
  async down(db) {
    await db.schema.alterTable("takes").addColumn("lead_ms", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
};
export default migration;
