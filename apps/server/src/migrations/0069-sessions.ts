import type { Migration } from "kysely/migration";

/**
 * The optional password (access.ts): the devices signed in, and the devices ever seen. A session's id is the SHA-256 of
 * the token its cookie holds, never the token itself: a copy of the database signs nobody in. `remember`: 1 when the
 * device was remembered (the cookie outlives the browser, until `expires_at`), 0 for a browser session that ends after
 * 12 h idle. A device is a browser's own long-lived cookie, hashed the same way: what tells a new one from one seen before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("device_id", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("last_seen_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("ip", "text", (c) => c.notNull())
      .addColumn("user_agent", "text", (c) => c.notNull())
      .addColumn("remember", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .createTable("devices")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("first_seen_at", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("sessions").execute();
    await db.schema.dropTable("devices").execute();
  },
};
export default migration;
