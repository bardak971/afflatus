import type { Migration } from "kysely/migration";

/**
 * A rented machine's sessions (rented.ts): each stretch a pod ran, read from its provider, with the rate it ran at. What a
 * rented GPU cost today and this month (the caps, the Rented GPUs card) is worked out from them; `ended_at` null while it runs.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("rent_sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("machine_id", "text", (c) => c.notNull())
      .addColumn("pod", "text", (c) => c.notNull())
      .addColumn("rate", "real", (c) => c.notNull())
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("ended_at", "text")
      .execute();
    await db.schema.createIndex("rent_sessions_started").on("rent_sessions").column("started_at").execute();
  },
  async down(db) {
    await db.schema.dropTable("rent_sessions").execute();
  },
};
export default migration;
