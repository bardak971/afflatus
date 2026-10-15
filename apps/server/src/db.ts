import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely, PostgresDialect, SqliteAdapter, SqliteDialect, sql, type DialectAdapter, type Driver, type SqliteDatabase } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { envSaid, type Config } from "./config";
import { migrations } from "./migrations";
import { WorkerSqliteDriver } from "./sqliteWorker";

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
  /** A folder's project is that of its top ancestor; null = the Inbox (in no project). */
  folders: { id: string; owner_id: string; parent_id: string | null; name: string; path: string | null; project_id: string | null; created_at: string };
  /** What drafts, timelines and folders are grouped under. `folder_id`: its root folder, where its things land unless another is chosen. */
  projects: { id: string; owner_id: string; name: string; folder_id: string | null; archived_at: string | null; created_at: string; updated_at: string };
  /** One row per file: a picture, a video or a sound. */
  assets: {
    id: string;
    owner_id: string;
    kind: "image" | "video" | "audio";
    /** "mask": the part of a picture that was painted over to redo it. Not shown in the library. */
    /** "kit": a picture or a voice sample uploaded for a person or a place of the Prompt kit, kept there and not shown in the library (like "mask"). */
    origin: "generated" | "uploaded" | "imported" | "frame" | "exported" | "mask" | "cut" | "kit" | "edited" | "scratch";
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
    /** What it was taken out of, when it is a frame or the sound of a video. */
    source_id: string | null;
    /** Of a video cut out of another: the range taken, "startMs-endMs". */
    source_range: string | null;
    /** Of a generated video whose frames were changed after the model made them: the model's own output, kept beside it for the clips that carry on from it. */
    raw_key: string | null;
    /** Of a MiniMax H3 video made with the Afflatus node pack: its latent (video and audio), for the clips that continue it; and how many frames it holds. */
    latent_key: string | null;
    latent_frames: number | null;
    /**
     * Of a clip finished by H3's latent re-sample: its re-sampled (enlarged) latent, for the finish of the clip after, which
     * decodes its join as one piece with it (seamless at the finished size). Not for new renders: those take latent_key.
     */
    fine_latent_key: string | null;
    /** null = not kept: goes to the bin after a day. */
    kept_at: string | null;
    /**
     * When the one-day countdown of a result nobody kept started, when it did not start at its making:
     * unkeeping it and taking it back from the bin start the day again. null = it counts from created_at.
     */
    countdown_from: string | null;
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
    /**
     * The recipe's version when it was rendered. Written and never read, on purpose: the day a recipe's inputs change
     * shape, it tells the records made before from those made after, which nothing else in the row can.
     */
    recipe_version: number;
    family: string;
    inputs: string;
    resolved: string;
    gen_ms: number;
    /** The draft it was made from, when it was made from one: "this draft" in Studio shows what its drafts made. */
    draft_id: string | null;
    /** The form as it was sent, before the cast was worked into it (JSON); null when no cast was, or from before it was kept. */
    asked?: string | null;
    /** How a rendered video's own part looks (JSON, see lookOf); null for a picture, or a video not measured. Also in resolved. */
    measure?: string | null;
    created_at: string;
  };
  /** Which assets a generation used, and as what: the lineage. */
  generation_inputs: { generation_id: string; asset_id: string; role: string };
  /**
   * What a search by words reads of each asset (assetSearch.ts): its name and the texts of the form it was made with, one
   * row per asset, kept by triggers and looked up through the FTS5 index `asset_words_index` (migration 0052). SQLite only:
   * on Postgres there is no such table.
   */
  asset_words: { doc: number; asset_id: string; words: string };
  /**
   * How long a render took, and where the time went: one row per render that ran on ComfyUI, finished
   * or not. Kept one by one for a while (a setting), then folded into `render_days`.
   */
  render_stats: {
    /** The job's id. */
    id: string;
    owner_id: string;
    recipe_id: string;
    family: string;
    /** The model it was made with, as a person would name it; and its file, as renders are compared. Empty when it has none of its own. */
    model: string;
    model_file: string;
    /** What of its settings decides how long it takes (see timeKey). */
    time_key: string;
    kind: "image" | "video" | "audio" | null;
    width: number | null;
    height: number | null;
    /** Of a video or a sound: its length. */
    duration_ms: number | null;
    steps: number;
    status: "done" | "failed" | "cancelled";
    /** 1: measured from its first moment (0: this process started while it was already rendering). */
    whole: number;
    /** 1: the model had to be loaded first. */
    cold: number;
    waited_ms: number;
    total_ms: number;
    load_ms: number;
    sample_ms: number;
    refine_ms: number;
    finish_ms: number;
    /** Of the first sampling pass; null when fewer than two steps were timed. */
    step_ms: number | null;
    /** What was expected before it started; null when nothing was known. */
    expected_ms: number | null;
    /** How much it sampled per step: its largest canvas in pixels times its frames (1 for a picture); null for renders before it was kept, or backfilled roughly. */
    work: number | null;
    /** Percent of the GPU's memory, and degrees; null when nothing reports them. */
    vram_peak: number | null;
    heat_peak: number | null;
    /** What it made (the first of them), to show beside its figures while it is still in the library. */
    asset_id: string | null;
    /** The machine it ran on (settings.ts `machines`), and its GPU's name as ComfyUI gave it: each machine's speed is learned from its own rows. */
    machine_id: string | null;
    gpu: string | null;
    /** JSON: milliseconds per node class (ComfyUI's class_type), from when each node started to when the next did; null when they were not heard. */
    node_ms: string | null;
    created_at: string;
  };
  /** The renders of one model on one day (UTC), folded: what the charts are drawn from once the rows are gone. Recipe "*" is the day as a whole. */
  render_days: {
    day: string;
    recipe_id: string;
    model_file: string;
    model: string;
    family: string;
    /** JSON: the figures of the day (see Cell in renderDigests.ts). */
    figures: string;
  };
  /** A day over whose renders are still rows, digested for the summaries cut into days (see Digest in renderDigests.ts); it goes when the day is folded. */
  render_digests: {
    day: string;
    /** JSON: the digest. */
    digest: string;
  };
  /** The same for one machine's renders of the day (render_stats.machine_id): what one machine's summary reads. */
  render_machine_digests: {
    day: string;
    machine_id: string;
    /** JSON: the digest. */
    digest: string;
  };
  jobs: {
    id: string;
    owner_id: string;
    recipe_id: string;
    label: string;
    inputs: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    /** 1: it only loads the models its render would use, and makes nothing. */
    warm: number;
    /** Who is in it and how it looks, as it was sent (JSON), to be kept with what it makes. */
    look: string | null;
    priority: number;
    /** A job that waits for another one (a clip that continues the clip before it). */
    depends_on: string | null;
    attempts: number;
    /** What is needed to wait on ComfyUI again after a restart (JSON), once the job was submitted. */
    resume: string | null;
    error: string | null;
    /** Of a job that failed in a ComfyUI node: the end of its Python traceback, as ComfyUI sent it; null otherwise. */
    error_trace?: string | null;
    generation_id: string | null;
    /** The timeline clip this renders a take of, when it is one. */
    clip_id: string | null;
    /** The timeline an export or a cut job works on, when it works on one: the timeline's export state is read by it. */
    timeline_id: string | null;
    /** For a clip: whether the take should end where the next clip begins (0 / 1). */
    clip_fit: number;
    /** For a clip: the pinned pictures it flips left to right as it uploads them (JSON, a list of input ids); null = none. */
    clip_mirror?: string | null;
    /** A finish job: the take whose finished version its result is. */
    finished_from: string | null;
    /** What went less well than asked in a job that still finished (its take not placed, a latent join made on frames); null when nothing did. */
    warning?: string | null;
    /** The form as it was sent, before the cast was worked into it (JSON): kept with what it makes. Null when no cast was. */
    asked?: string | null;
    /** The draft it was sent from, and the folder its results go to: the one that was open when it was sent. */
    draft_id: string | null;
    folder_id: string | null;
    /** The machine (settings.ts `machines`) it runs or ran on, set when it is claimed; null for a job that needs no ComfyUI. */
    machine_id?: string | null;
    /** The machine it was pinned to by hand; null: whichever the queue picks. */
    pin_machine?: string | null;
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
    /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root, or none). */
    project_id: string | null;
    folder_id: string | null;
    /** 1: the folder was chosen by hand; 0: it is the default (the project's root), or taken from the first material dropped on the timeline. */
    folder_chosen: number;
    width: number | null;
    height: number | null;
    /** One sound under the whole video: the file, how loud (0 to 100), its fades, and whether it gives way to the clips' own sound. */
    music_asset_id: string | null;
    music_volume: number;
    music_fade_in_ms: number;
    music_fade_out_ms: number;
    music_duck: number;
    /** How far the music goes down under speech, in dB. */
    music_duck_db: number;
    /** Where in the song it plays from, and the clip it starts with (null: the first). */
    music_from_ms: number;
    music_start_clip_id: string | null;
    /** The last video it was exported as. */
    export_asset_id: string | null;
    /** Its cast, places and style (JSON), used by every clip that has none of its own. */
    look: string | null;
    /** The look and mood of the whole video, in words: added to what happens in every clip. */
    mood: string | null;
    /** Its source lane: a long video made into clips window by window (JSON, timelineSource.ts SourcePlan); null = none. */
    source?: string | null;
    created_at: string;
    updated_at: string;
  };
  /**
   * People, places, styles and presets: one JSON document each (entities.ts says what each kind holds).
   */
  entities: { id: string; owner_id: string; kind: "person" | "place" | "style" | "preset" | "snippet"; name: string; def: string; created_at: string; updated_at: string };
  /** What a timeline looked like before each change, newest last: what Undo goes back to. */
  timeline_history: { id: string; timeline_id: string; /** Counts up within a timeline: the order of the changes. */ seq: number; label: string; snapshot: string; created_at: string };
  /** What Undo took back, to be done again: the same shape; emptied by the next change. */
  timeline_future: { id: string; timeline_id: string; seq: number; label: string; snapshot: string; created_at: string };
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
    /** 1 = rendered to end where the next clip begins, when that one carries on from it (a pinned last frame wins); 0 = left to end as it will. */
    fit_next?: number;
    /** Its own cast, places and style (JSON); null = the timeline's. */
    look: string | null;
    /** The conversation with the designer about this clip (JSON). */
    chat: string | null;
    /** Which language model and which instructions that conversation is held with (JSON); null = the usual ones. */
    designer?: string | null;
    /** What it asks of the music under it (JSON, @afflatus/core's ClipMusic); null = as the rest of the video. */
    music?: string | null;
    /** Its pinned pictures flipped left to right at render time (JSON, input id → true), the library's picture left as it is; null = none. */
    pin_mirror?: string | null;
    /** A cut's transition into this clip (JSON, @afflatus/core's Transition); null = a plain cut. */
    transition?: string | null;
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
    /** The take this one is the finished (upscaled) version of: the draft stays in the list. */
    finished_from: string | null;
    /** How its start joins the clip before: in the latent (the clip before's own tokens continued), or pinned frames; null when it does not continue a clip. */
    join_kind: "seamless" | "latent" | "hybrid" | "pixels" | null;
    created_at: string;
  };
  /** Imported ComfyUI workflows: the workflow and its mapping, as one JSON document each. */
  workflows: { id: string; owner_id: string; def: string; created_at: string; updated_at: string };
  /**
   * What a model file says about itself (read once from its header, through ComfyUI), as JSON. `read_at` is written and
   * never read, on purpose: what was read is told stale by its `v` (MODEL_INFO_VERSION), and the date says when, for
   * someone looking at the database by hand.
   */
  model_info: { folder: string; file: string; info: string; read_at: string };
  /** The page of a model file on the site it came from, by the file's name (lower case, without its sub-folder). */
  model_pages: { folder: string; name: string; url: string; title: string; found_at: string };
  /**
   * The words that call a model file up, beyond what the file says itself, by the file's name: the user's
   * own, and the ones its page gives. `asked_at` is set once its page was asked, found or not.
   */
  model_words: { folder: string; name: string; own: string | null; found: string | null; asked_at: string | null };
  /** A model file matched to its Civitai version (by the file's name, lower case, without its sub-folder), and the newer version when Civitai has one. */
  model_updates: {
    folder: string;
    name: string;
    file: string;
    model_id: number;
    model_name: string;
    version_id: number;
    version_name: string;
    latest_id: number | null;
    latest_name: string | null;
    latest_at: string | null;
    latest_file: string | null;
    checked_at: string;
  };
  /** What suits one model file: the values that replace a recipe's defaults when that file is picked (JSON: input id → value). */
  model_settings: { owner_id: string; family: string; file: string; values: string; updated_at: string };
  /** A rented machine's stretches of running (rented.ts): its pod, the rate it ran at, from when to when (null: running). */
  rent_sessions: { id: string; machine_id: string; pod: string; rate: number; started_at: string; ended_at: string | null; seen_at: string | null };
  /** What rented pods were measured at (podFiles.ts): a file's bytes over its time per source (hf, civitai, upload), a deploy's boot (ms). */
  pod_measures: { id: string; kind: string; cloud: string | null; bytes: number; ms: number; at: string };
  /** Every model file of this computer hashed once, and the site version or file it is (modelHashes.ts). Sizes and times as numbers (bigint on Postgres: read through Number). */
  model_hashes: { folder: string; file: string; size: number | string; mtime: number | string; sha256: string; hashed_at: string; civitai_version: number | string | null; hf_url: string | null; matched_at: string | null };
  /** What each network volume holds, as the last pod on it listed its folders (rentedVolumes.ts): file keys as JSON. */
  volume_files: { volume_id: string; files: string | null; seen_at: string | null; seen_by: string | null; used_at: string | null; noticed_at: string; fill_note: string | null };
  /** The devices signed in while a password is set (access.ts): the id is the SHA-256 of the cookie's token; `remember` 1 or 0. */
  sessions: { id: string; device_id: string; created_at: string; last_seen_at: string; expires_at: string; ip: string; user_agent: string; remember: number };
  /** Every device that ever signed in, by the SHA-256 of its own cookie: a sign-in from one not here is told of (newDevice). */
  devices: { id: string; first_seen_at: string; name: string };
  /** Named lists of model files (modelSets.ts): presets by reference and files of their own, as JSON in `def`. */
  model_sets: { id: string; owner_id: string; name: string; def: string; created_at: string; updated_at: string };
  /** Unfinished work, saved as it is typed. */
  drafts: {
    id: string;
    owner_id: string;
    /** The project it belongs to; null: the Inbox. */
    project_id: string | null;
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
    // a bigint column (a file's size, a render's work) comes back as a number, as SQLite's does, not as a string
    const types = { getTypeParser: ((oid: number, format?: "text" | "binary") => (oid === pg.types.builtins.INT8 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as "text"))) as typeof pg.types.getTypeParser };
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, types });
    return { db: new Kysely<Tables>({ dialect: new PostgresDialect({ pool }) }), kind: "postgres" };
  }
  mkdirSync(config.dataDir, { recursive: true });
  return { db: openSqlite(takeOver(config.dataDir)), kind: "sqlite" };
}

/** The database file: the one written under the app's earlier name (studai.db) is renamed once, with its journal. */
export function takeOver(dataDir: string): string {
  const file = join(dataDir, "afflatus.db");
  if (!existsSync(file) && existsSync(join(dataDir, "studai.db"))) {
    for (const tail of ["", "-wal", "-shm"]) if (existsSync(join(dataDir, `studai.db${tail}`))) renameSync(join(dataDir, `studai.db${tail}`), `${file}${tail}`);
  }
  return file;
}

/**
 * ":memory:" for tests. `worker`: the statements run in a worker thread (sqliteWorker.ts), so that a long read does not
 * hold the server's other requests; `inline`: on this thread. Left out, AFFLATUS_SQLITE_WORKER=1 says which. The thread
 * stays the default for now: each statement then crosses to the worker and back, and with every core busy (an export, a
 * cut: ffmpeg takes them all) each crossing waits for the scheduler, so a route of many statements took several times as
 * long (measured at scale: 1.3 to 22 times, the most for the routes of many small statements). The routes no longer
 * count on nothing coming in between two statements (keyedLock.ts, test/races.test.ts).
 */
export function openSqlite(file: string, opts: { worker?: boolean; inline?: boolean } = {}): Db {
  if (opts.inline || !(opts.worker ?? envSaid.sqliteWorker())) {
    const sqlite = new DatabaseSync(file);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    return new Kysely<Tables>({ dialect: new TransactionalSqlite({ database: forKysely(sqlite) }) });
  }
  return new Kysely<Tables>({ dialect: new WorkerSqlite(file) });
}

/**
 * SQLite takes schema changes inside a transaction as well as Postgres does; Kysely's adapter only says it
 * does not. Saying it does makes the migrator run the pending migrations and their record in one
 * transaction, as on Postgres: one that fails half way leaves nothing behind, instead of a column added
 * and not recorded that the next start trips over.
 */
class TransactionalSqlite extends SqliteDialect {
  override createAdapter(): DialectAdapter {
    return new (class extends SqliteAdapter {
      override get supportsTransactionalDdl(): boolean {
        return true;
      }
    })();
  }
}

/** The same dialect, with the database in a worker thread. */
class WorkerSqlite extends TransactionalSqlite {
  constructor(private readonly file: string) {
    // The database given to the base class is never opened: the driver below has its own, in the worker.
    super({ database: {} as SqliteDatabase });
  }

  override createDriver(): Driver {
    return new WorkerSqliteDriver(this.file);
  }
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

/**
 * Bring the schema up to date. `upTo`: stop at that migration instead (tests, to seed a database as an older
 * version left it). On SQLite a copy of the database is made first when a migration is pending
 * (afflatus.db.pre-<first pending>, beside it; only the copy before the latest update is kept).
 */
export async function migrate(db: Db, upTo?: string): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  await copyBefore(db, migrator);
  const { error, results } = upTo ? await migrator.migrateTo(upTo) : await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  // SQLite keeps the planner's figures on the tables only when asked: fresh ones let it pick the right index as the library
  // grows. `optimize` looks only at the tables that need it (0x10002: all of them, on a connection just opened), so it is cheap
  // on every start (Postgres analyzes by itself).
  if (db.getExecutor().adapter instanceof SqliteAdapter) await sql`pragma optimize = 0x10002`.execute(db);
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** A copy of a SQLite database file before its migrations run, made by SQLite itself; none for a new database or one in memory. */
async function copyBefore(db: Db, migrator: Migrator): Promise<void> {
  if (!(db.getExecutor().adapter instanceof SqliteAdapter)) return;
  const all = await migrator.getMigrations();
  const pending = all.find((m) => !m.executedAt);
  if (!pending || !all.some((m) => m.executedAt)) return;
  const main = (await sql<{ name: string; file: string }>`pragma database_list`.execute(db)).rows.find((r) => r.name === "main");
  if (!main?.file || !existsSync(main.file)) return;
  const dir = dirname(main.file);
  const stem = `${basename(main.file)}.pre-`;
  for (const old of readdirSync(dir).filter((f) => f.startsWith(stem))) rmSync(join(dir, old), { force: true });
  await sql`vacuum into ${join(dir, `${stem}${pending.name}`)}`.execute(db);
}
