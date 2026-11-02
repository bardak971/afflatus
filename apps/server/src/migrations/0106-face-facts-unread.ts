import type { Migration } from "kysely/migration";

/**
 * The pictures filed "no face" because the node pack could not read them (card #233) read again. Before pack 0.49.2 the
 * route answered 422 for InsightFace failing to load or fetch its files, which the reader took for a picture that cannot be
 * read: within minutes of a machine without its models, the whole kit was filed faceless for good, and the best face no
 * longer went first. Those rows are the reader's "unreadable" mark (a 1 × 1 picture, no face), never a picture read: a
 * picture that really cannot be read is filed so again.
 */
const UNREADABLE = JSON.stringify({ version: 1, width: 1, height: 1, faces: 0, face: null });

const migration: Migration = {
  async up(db) {
    await db.deleteFrom("face_facts").where("facts", "=", UNREADABLE).execute();
  },
  // nothing to put back: the pictures are read again
  async down() {},
};
export default migration;
