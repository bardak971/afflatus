import type { Migration } from "kysely/migration";

/**
 * The base model Civitai gives a hashed file's version ("LTXV 2.3", "Wan Video 2.2 I2V-A14B"): finer than what a LoRA's
 * header says ("LTX" for every LTX), it tells a LoRA made for another version of a model (modelSet.ts). Null until asked,
 * "" when Civitai gives none.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("model_hashes").addColumn("civitai_base", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("model_hashes").dropColumn("civitai_base").execute();
  },
};
export default migration;
