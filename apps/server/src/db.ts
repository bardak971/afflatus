import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely, PostgresDialect, SqliteDialect, type SqliteDatabase } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import pg from "pg";
import type { Config } from "./config";

/**
 * One schema for both databases. To keep it that way: ids and timestamps are text (ISO 8601),
 * JSON is stored as text, booleans as 0 / 1 integers. No dialect-specific column types.
 *
 * Every table that holds someone's work has owner_id. There is one user today ("local"); the column is
 * there so that accounts can be added later without rewriting the schema.
 */
export interface Tables {
  settings: { key: string; value: string; updated_at: string };
  /** `path`: the directory of the disk a folder is linked to (see linked.ts); null for a folder that only exists in the library. */
  folders: { id: string; owner_id: string; parent_id: string | null; name: string; path: string | null; created_at: string };
  /** One row per file: a picture, a video or a sound. */
  assets: {
    id: string;
    owner_id: string;
    kind: "image" | "video" | "audio";
    /** "mask": the part of a picture that was painted over to redo it. Not shown in the library. */
    origin: "generated" | "uploaded" | "imported" | "frame" | "exported" | "mask";
    name: string;
    file_key: string;
    thumb_key: string | null;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    fps: number | null;
    has_sound: number;
    folder_id: string | null;
    generation_id: string | null;
    /** null = not kept: goes to the bin after a day. */
    kept_at: string | null;
    /** set = in the bin. */
    deleted_at: string | null;
    /** Of a file of a linked folder that is in the bin: where it was on the disk, to put it back there. */
    linked_path: string | null;
    created_at: string;
  };
  /** How an asset was made: the recipe, the inputs as submitted, and what was resolved at render time. */
  generations: {
    id: string;
    owner_id: string;
    recipe_id: string;
    recipe_version: number;
    family: string;
    inputs: string;
    resolved: string;
    gen_ms: number;
    /** The draft it was made from, when it was made from one: "this draft" in Studio shows what its drafts made. */
    draft_id: string | null;
    created_at: string;
  };
  /** Which assets a generation used, and as what: the lineage. */
  generation_inputs: { generation_id: string; asset_id: string; role: string };
  jobs: {
    id: string;
    owner_id: string;
    recipe_id: string;
    label: string;
    inputs: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    priority: number;
    /** A job that waits for another one (a clip that continues the clip before it). */
    depends_on: string | null;
    attempts: number;
    /** What is needed to wait on ComfyUI again after a restart (JSON), once the job was submitted. */
    resume: string | null;
    error: string | null;
    generation_id: string | null;
    /** The timeline clip this renders a take of, when it is one. */
    clip_id: string | null;
    /** For a clip: whether the take should end where the next clip begins (0 / 1). */
    clip_fit: number;
    /** The draft it was sent from, and the folder its results go to: the one that was open when it was sent. */
    draft_id: string | null;
    folder_id: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
  };
  /** A video made of clips played one after the other. No width = the first clip rendered decides the frame. */
  timelines: {
    id: string;
    owner_id: string;
    name: string;
    width: number | null;
    height: number | null;
    /** One sound under the whole video: the file, how loud (0 to 100), its fades, and whether it gives way to the clips' own sound. */
    music_asset_id: string | null;
    music_volume: number;
    music_fade_in_ms: number;
    music_fade_out_ms: number;
    music_duck: number;
    /** The last video it was exported as. */
    export_asset_id: string | null;
    /** Its cast, places and style (JSON), used by every clip that has none of its own. */
    look: string | null;
    /** The look and mood of the whole video, in words: added to what happens in every clip. */
    mood: string | null;
    created_at: string;
    updated_at: string;
  };
  /**
   * People, places, styles and presets: one JSON document each (entities.ts says what each kind holds).
   */
  entities: { id: string; owner_id: string; kind: "person" | "place" | "style" | "preset" | "snippet"; name: string; def: string; created_at: string; updated_at: string };
  /** What a timeline looked like before each change, newest last: what Undo goes back to. */
  timeline_history: { id: string; timeline_id: string; /** Counts up within a timeline: the order of the changes. */ seq: number; label: string; snapshot: string; created_at: string };
  /** One place on a timeline: what to render there (a recipe and its form) and which of its takes plays. */
  clips: {
    id: string;
    timeline_id: string;
    position: number;
    /** The take that plays. null = nothing rendered yet. */
    take_id: string | null;
    /** How it starts: carrying on from the clip before it, or on its own. */
    joined: "continue" | "cut";
    recipe_id: string | null;
    /** The clip's form (JSON: input id → value). */
    inputs: string;
    /** "still": a picture held on screen for a while, instead of a video. */
    kind: "video" | "still";
    still_asset_id: string | null;
    still_ms: number;
    /** What is heard while it plays: its own sound, nothing, or a sound file. And how loud (0 to 100). */
    sound: "own" | "muted" | "file";
    sound_asset_id: string | null;
    volume: number;
    /** A clip of another shape than the timeline: 1 = it fills the frame (its edges are cut), 0 = it is shown whole, with bars. */
    fill: number;
    /** Its own cast, places and style (JSON); null = the timeline's. */
    look: string | null;
    /** The conversation with the designer about this clip (JSON). */
    chat: string | null;
    /** Which language model and which instructions that conversation is held with (JSON); null = the usual ones. */
    designer?: string | null;
    created_at: string;
    updated_at: string;
  };
  /** One render of a clip (or a video put there by hand). */
  takes: {
    id: string;
    clip_id: string;
    asset_id: string;
    /** How much of the video repeats the clip before it (skipped at its start) and the clip after it (skipped at its end). */
    head_ms: number;
    tail_ms: number;
    /** Cut off by hand, on top of that. */
    trim_start_ms: number;
    trim_end_ms: number;
    /** The take it carried on from and the moment in it; the take it was made to arrive at and the moment in it. */
    prev_take_id: string | null;
    prev_at_ms: number | null;
    next_take_id: string | null;
    next_at_ms: number | null;
    created_at: string;
  };
  /** Imported ComfyUI workflows: the workflow and its mapping, as one JSON document each. */
  workflows: { id: string; owner_id: string; def: string; created_at: string; updated_at: string };
  /** What a model file says about itself (read once from its header, through ComfyUI), as JSON. */
  model_info: { folder: string; file: string; info: string; read_at: string };
  /** The page of a model file on the site it came from, by the file's name (lower case, without its sub-folder). */
  model_pages: { folder: string; name: string; url: string; title: string; found_at: string };
  /**
   * The words that call a model file up, beyond what the file says itself, by the file's name: the user's
   * own, and the ones its page gives. `asked_at` is set once its page was asked, found or not.
   */
  model_words: { folder: string; name: string; own: string | null; found: string | null; asked_at: string | null };
  /** What suits one model file: the values that replace a recipe's defaults when that file is picked (JSON: input id → value). */
  model_settings: { owner_id: string; family: string; file: string; values: string; updated_at: string };
  /** Unfinished work, saved as it is typed. */
  drafts: {
    id: string;
    owner_id: string;
    /** What it is for: "new", "asset:<id>" (an edit of something), "clip:<id>" (a timeline clip). */
    target: string;
    /** The recipe the form is on. */
    recipe_id: string;
    /** For lists: the start of what was written. */
    title: string;
    /** The name its owner gave it, when they gave one: shown instead of the start of what was written. */
    name: string | null;
    /** The form of every recipe this draft has been on (JSON: recipe id → values), so switching model and back loses nothing. */
    forms: string;
    count: number;
    /** The prompt designer's conversation about this draft (JSON), when there is one. */
    chat: string | null;
    /** Which language model and which instructions that conversation is held with (JSON); null = the usual ones. */
    designer?: string | null;
    /** Who is in it and how it looks (JSON): people, places, a style. */
    look: string | null;
    created_at: string;
    updated_at: string;
  };
}
export type Db = Kysely<Tables>;
export type DbKind = "sqlite" | "postgres";

export const OWNER = "local";
export const newId = () => randomUUID().replace(/-/g, "");
export const now = () => new Date().toISOString();

export function openDb(config: Config): { db: Db; kind: DbKind } {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
    return { db: new Kysely<Tables>({ dialect: new PostgresDialect({ pool }) }), kind: "postgres" };
  }
  mkdirSync(config.dataDir, { recursive: true });
  return { db: openSqlite(join(config.dataDir, "studai.db")), kind: "sqlite" };
}

/** ":memory:" for tests. */
export function openSqlite(file: string): Db {
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return new Kysely<Tables>({ dialect: new SqliteDialect({ database: forKysely(sqlite) }) });
}

/**
 * Node's built-in SQLite, in the shape Kysely's SQLite dialect expects (better-sqlite3's). Using the
 * built-in one means the PC mode has no native module to compile: better-sqlite3 needs a C++
 * toolchain when no prebuilt binary matches, which is exactly what a first-time user doesn't have.
 */
function forKysely(sqlite: DatabaseSync): SqliteDatabase {
  type Param = null | number | bigint | string | Uint8Array;
  return {
    close: () => sqlite.close(),
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        // a statement "reads" when it returns rows (SELECT, or anything with RETURNING)
        reader: stmt.columns().length > 0,
        all: (params) => stmt.all(...(params as Param[])),
        run: (params) => stmt.run(...(params as Param[])),
        iterate: (params) => stmt.iterate(...(params as Param[])) as IterableIterator<unknown>,
      };
    },
  };
}

/** Migrations live in code (one list, both databases), written with Kysely's schema builder only. */
const migrations: Record<string, Migration> = {
  "0001_settings": {
    async up(db) {
      await db.schema
        .createTable("settings")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
    },
    async down(db) {
      await db.schema.dropTable("settings").execute();
    },
  },
  "0002_library_and_queue": {
    async up(db) {
      await db.schema
        .createTable("folders")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("parent_id", "text")
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createTable("generations")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("recipe_id", "text", (c) => c.notNull())
        .addColumn("recipe_version", "integer", (c) => c.notNull())
        .addColumn("family", "text", (c) => c.notNull())
        .addColumn("inputs", "text", (c) => c.notNull())
        .addColumn("resolved", "text", (c) => c.notNull())
        .addColumn("gen_ms", "integer", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createTable("assets")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("origin", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("file_key", "text", (c) => c.notNull())
        .addColumn("thumb_key", "text")
        .addColumn("mime", "text", (c) => c.notNull())
        .addColumn("bytes", "integer", (c) => c.notNull())
        .addColumn("width", "integer")
        .addColumn("height", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("fps", "real")
        .addColumn("has_sound", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("folder_id", "text", (c) => c.references("folders.id").onDelete("set null"))
        .addColumn("generation_id", "text", (c) => c.references("generations.id").onDelete("set null"))
        .addColumn("kept_at", "text")
        .addColumn("deleted_at", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("assets_by_time").on("assets").columns(["owner_id", "created_at"]).execute();
      await db.schema.createIndex("assets_by_folder").on("assets").column("folder_id").execute();
      await db.schema
        .createTable("generation_inputs")
        .addColumn("generation_id", "text", (c) => c.notNull().references("generations.id").onDelete("cascade"))
        .addColumn("asset_id", "text", (c) => c.notNull().references("assets.id").onDelete("cascade"))
        .addColumn("role", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("generation_inputs_pk", ["generation_id", "asset_id", "role"])
        .execute();
      await db.schema
        .createTable("jobs")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("recipe_id", "text", (c) => c.notNull())
        .addColumn("label", "text", (c) => c.notNull())
        .addColumn("inputs", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("priority", "integer", (c) => c.notNull())
        .addColumn("depends_on", "text")
        .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("resume", "text")
        .addColumn("error", "text")
        .addColumn("generation_id", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("started_at", "text")
        .addColumn("finished_at", "text")
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("jobs_by_status").on("jobs").columns(["status", "priority", "created_at"]).execute();
    },
    async down(db) {
      for (const t of ["jobs", "generation_inputs", "assets", "generations", "folders"]) await db.schema.dropTable(t).execute();
    },
  },
  "0003_drafts": {
    async up(db) {
      await db.schema
        .createTable("drafts")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("target", "text", (c) => c.notNull())
        .addColumn("recipe_id", "text", (c) => c.notNull())
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("forms", "text", (c) => c.notNull())
        .addColumn("count", "integer", (c) => c.notNull())
        .addColumn("chat", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("drafts_by_time").on("drafts").columns(["owner_id", "updated_at"]).execute();
    },
    async down(db) {
      await db.schema.dropTable("drafts").execute();
    },
  },
  "0004_model_settings": {
    async up(db) {
      await db.schema
        .createTable("model_settings")
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("family", "text", (c) => c.notNull())
        .addColumn("file", "text", (c) => c.notNull())
        .addColumn("values", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("model_settings_pk", ["owner_id", "family", "file"])
        .execute();
    },
    async down(db) {
      await db.schema.dropTable("model_settings").execute();
    },
  },
  "0005_workflows": {
    async up(db) {
      await db.schema
        .createTable("workflows")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("def", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
    },
    async down(db) {
      await db.schema.dropTable("workflows").execute();
    },
  },
};

migrations["0006_model_info"] = {
  async up(db) {
    await db.schema
      .createTable("model_info")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("info", "text", (c) => c.notNull())
      .addColumn("read_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_info_pk", ["folder", "file"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_info").execute();
  },
};

migrations["0007_timelines"] = {
  async up(db) {
    await db.schema
      .createTable("timelines")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("width", "integer")
      .addColumn("height", "integer")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("clips")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("timeline_id", "text", (c) => c.notNull().references("timelines.id").onDelete("cascade"))
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("take_id", "text")
      .addColumn("joined", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text")
      .addColumn("inputs", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("clips_by_timeline").on("clips").columns(["timeline_id", "position"]).execute();
    await db.schema
      .createTable("takes")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("clip_id", "text", (c) => c.notNull().references("clips.id").onDelete("cascade"))
      .addColumn("asset_id", "text", (c) => c.notNull().references("assets.id").onDelete("cascade"))
      .addColumn("head_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("tail_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("trim_start_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("trim_end_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("prev_take_id", "text")
      .addColumn("prev_at_ms", "integer")
      .addColumn("next_take_id", "text")
      .addColumn("next_at_ms", "integer")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("takes_by_clip").on("takes").column("clip_id").execute();
    await db.schema.alterTable("jobs").addColumn("clip_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("clip_fit", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("clip_fit").execute();
    await db.schema.alterTable("jobs").dropColumn("clip_id").execute();
    for (const t of ["takes", "clips", "timelines"]) await db.schema.dropTable(t).execute();
  },
};

migrations["0008_timeline_editor"] = {
  async up(db) {
    const add = (table: "timelines" | "clips", name: string, type: "text" | "integer", fallback?: string | number) =>
      db.schema.alterTable(table).addColumn(name, type, (c) => (fallback === undefined ? c : c.notNull().defaultTo(fallback))).execute();
    await add("timelines", "music_asset_id", "text");
    await add("timelines", "music_volume", "integer", 60);
    await add("timelines", "music_fade_in_ms", "integer", 1000);
    await add("timelines", "music_fade_out_ms", "integer", 3000);
    await add("timelines", "music_duck", "integer", 1);
    await add("timelines", "export_asset_id", "text");
    await add("clips", "kind", "text", "video");
    await add("clips", "still_asset_id", "text");
    await add("clips", "still_ms", "integer", 3000);
    await add("clips", "sound", "text", "own");
    await add("clips", "sound_asset_id", "text");
    await add("clips", "volume", "integer", 100);
    await add("clips", "fill", "integer", 0);
    await db.schema
      .createTable("timeline_history")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("timeline_id", "text", (c) => c.notNull().references("timelines.id").onDelete("cascade"))
      .addColumn("seq", "integer", (c) => c.notNull())
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("snapshot", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("timeline_history_by_timeline").on("timeline_history").columns(["timeline_id", "seq"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("timeline_history").execute();
    for (const c of ["fill", "volume", "sound_asset_id", "sound", "still_ms", "still_asset_id", "kind"]) await db.schema.alterTable("clips").dropColumn(c).execute();
    for (const c of ["export_asset_id", "music_duck", "music_fade_out_ms", "music_fade_in_ms", "music_volume", "music_asset_id"]) await db.schema.alterTable("timelines").dropColumn(c).execute();
  },
};

migrations["0009_people"] = {
  async up(db) {
    await db.schema
      .createTable("entities")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("def", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("entities_by_kind").on("entities").columns(["owner_id", "kind"]).execute();
    for (const table of ["timelines", "clips", "drafts"] as const) await db.schema.alterTable(table).addColumn("look", "text").execute();
  },
  async down(db) {
    for (const table of ["timelines", "clips", "drafts"] as const) await db.schema.alterTable(table).dropColumn("look").execute();
    await db.schema.dropTable("entities").execute();
  },
};

migrations["0010_mood"] = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("mood", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("mood").execute();
  },
};

migrations["0014_designer_session"] = {
  async up(db) {
    await db.schema.alterTable("drafts").addColumn("designer", "text").execute();
    await db.schema.alterTable("clips").addColumn("designer", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("drafts").dropColumn("designer").execute();
    await db.schema.alterTable("clips").dropColumn("designer").execute();
  },
};

migrations["0013_model_pages"] = {
  async up(db) {
    await db.schema
      .createTable("model_pages")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("url", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("found_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_pages_pk", ["folder", "name"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_pages").execute();
  },
};

migrations["0017_linked_folders"] = {
  async up(db) {
    await db.schema.alterTable("folders").addColumn("path", "text").execute();
    await db.schema.alterTable("assets").addColumn("linked_path", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("folders").dropColumn("path").execute();
    await db.schema.alterTable("assets").dropColumn("linked_path").execute();
  },
};

migrations["0016_job_draft_folder"] = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("draft_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("folder_id", "text").execute();
    await db.schema.alterTable("generations").addColumn("draft_id", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("draft_id").execute();
    await db.schema.alterTable("jobs").dropColumn("folder_id").execute();
    await db.schema.alterTable("generations").dropColumn("draft_id").execute();
  },
};

migrations["0015_model_words"] = {
  async up(db) {
    await db.schema
      .createTable("model_words")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("own", "text")
      .addColumn("found", "text")
      .addColumn("asked_at", "text")
      .addPrimaryKeyConstraint("model_words_pk", ["folder", "name"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_words").execute();
  },
};

migrations["0012_draft_name"] = {
  async up(db) {
    await db.schema.alterTable("drafts").addColumn("name", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("drafts").dropColumn("name").execute();
  },
};

migrations["0011_clip_chat"] = {
  async up(db) {
    await db.schema.alterTable("clips").addColumn("chat", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("clips").dropColumn("chat").execute();
  },
};

export async function migrate(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
