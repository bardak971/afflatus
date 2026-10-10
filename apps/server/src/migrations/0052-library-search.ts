import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { onPostgres } from "./dialect";

/**
 * The library's search index (assetSearch.ts): what a search by words reads of each item, its name and every text of the
 * form it was made with, as `fuzzyFilter` reads them, in `asset_words`; and an FTS5 trigram index over it, so that a search
 * looks up the items holding each word typed instead of reading thousands of rows per keystroke. Kept by triggers, so that
 * every way an item is written (made, renamed, imported, erased) keeps it, and so does a generation changed or erased
 * after its items were made.
 *
 * SQLite only: on Postgres the search reads the library as it did before (there is no FTS5 there, and a pg_trgm twin
 * could not be run here).
 */

/** An item's words, as `${name} ${the form's texts joined by a space}`: the texts are the top-level strings of its inputs, in their order. */
const wordsSql = (item: string) =>
  `${item}.name || ' ' || coalesce((select group_concat(j.value, ' ' order by j.id) from generations g, json_each(case when json_valid(g.inputs) then g.inputs else '{}' end) j where g.id = ${item}.generation_id and j.type = 'text'), '')`;
const wordsOf = (item: string) => sql.raw(wordsSql(item));
/** The items of a generation, their words worked out again: when the generation changes, is erased, or comes after them (foreign keys off). */
const refresh = (generation: string) => sql.raw(
  `update asset_words set words = (select ${wordsSql("a")} from assets a where a.id = asset_words.asset_id) where asset_id in (select id from assets where generation_id = ${generation});`,
);

const TRIGGERS = ["asset_words_add", "asset_words_change", "asset_words_drop", "asset_words_generation_add", "asset_words_generation_change", "asset_words_generation_drop", "asset_words_index_add", "asset_words_index_change", "asset_words_index_drop"];

const migration: Migration = {
  async up(db) {
    if (onPostgres(db)) return;
    // `doc` is the index's rowid: an integer primary key, which a VACUUM (a backup, the copy made before a migration) keeps as it is
    await sql`create table asset_words (doc integer primary key, asset_id text not null unique, words text not null)`.execute(db);
    await sql`insert into asset_words (asset_id, words) select assets.id, ${wordsOf("assets")} from assets`.execute(db);
    // trigrams find a word typed anywhere in a text (in a word, in any script), as the forgiving match does; folded as it folds
    await sql`create virtual table asset_words_index using fts5(words, content='asset_words', content_rowid='doc', tokenize='trigram remove_diacritics 2')`.execute(db);
    await sql`insert into asset_words_index (asset_words_index) values ('rebuild')`.execute(db);

    // the index follows its table, as SQLite's external-content tables are kept
    await sql`create trigger asset_words_index_add after insert on asset_words begin
      insert into asset_words_index (rowid, words) values (new.doc, new.words);
    end`.execute(db);
    await sql`create trigger asset_words_index_drop after delete on asset_words begin
      insert into asset_words_index (asset_words_index, rowid, words) values ('delete', old.doc, old.words);
    end`.execute(db);
    await sql`create trigger asset_words_index_change after update of words on asset_words begin
      insert into asset_words_index (asset_words_index, rowid, words) values ('delete', old.doc, old.words);
      insert into asset_words_index (rowid, words) values (new.doc, new.words);
    end`.execute(db);

    // an item written over another of the same id (an insert that replaces) leaves no row of the old one behind
    await sql`create trigger asset_words_add after insert on assets begin
      delete from asset_words where asset_id = new.id;
      insert into asset_words (asset_id, words) values (new.id, ${wordsOf("new")});
    end`.execute(db);
    await sql`create trigger asset_words_change after update of name, generation_id on assets begin
      update asset_words set words = ${wordsOf("new")} where asset_id = new.id;
    end`.execute(db);
    await sql`create trigger asset_words_drop after delete on assets begin
      delete from asset_words where asset_id = old.id;
    end`.execute(db);
    await sql`create trigger asset_words_generation_add after insert on generations begin ${refresh("new.id")} end`.execute(db);
    await sql`create trigger asset_words_generation_change after update of inputs on generations begin ${refresh("new.id")} end`.execute(db);
    await sql`create trigger asset_words_generation_drop after delete on generations begin ${refresh("old.id")} end`.execute(db);
  },
  async down(db) {
    if (onPostgres(db)) return;
    for (const t of TRIGGERS) await sql`drop trigger if exists ${sql.raw(t)}`.execute(db);
    await sql`drop table if exists asset_words_index`.execute(db);
    await sql`drop table if exists asset_words`.execute(db);
  },
};
export default migration;
