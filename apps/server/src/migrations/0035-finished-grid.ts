import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a finished take has its draft's frames, enlarged: its length on the model's frame grid is the draft's (lengthOnGrid).
    // Without it an interpolated finish played one frame short of its draft and a seamless join skipped that frame
    await sql`update assets set latent_frames = (select d.latent_frames from takes f join takes dt on dt.id = f.finished_from join assets d on d.id = dt.asset_id where f.asset_id = assets.id and d.latent_frames is not null and abs(coalesce(d.duration_ms, 0) - coalesce(assets.duration_ms, 0)) <= 42 limit 1) where latent_frames is null and id in (select asset_id from takes where finished_from is not null)`.execute(db);
  },
  async down() {},
};
export default migration;
