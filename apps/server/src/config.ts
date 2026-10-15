import { resolve } from "node:path";

/**
 * Two ways to run, chosen by the environment alone:
 *  - on one PC: nothing set. SQLite and files under DATA_DIR.
 *  - on a cluster: DATABASE_URL (Postgres); the files stay under DATA_DIR, on the volume the chart mounts (storage.ts
 *    is shaped for a bucket, but none is written).
 */
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** postgres://… ; empty = SQLite at <dataDir>/afflatus.db */
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = environment()): Config {
  return {
    // localhost only by default: listening on the network is a choice. Without a password (Settings › Interface › Access,
    // access.ts) anyone who reaches the port can use it, so HOST is opened only to a trusted network or with one set
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number(env.PORT) || 8720,
    dataDir: resolve(env.DATA_DIR?.trim() || "data"),
    databaseUrl: env.DATABASE_URL?.trim() ?? "",
  };
}

/**
 * The environment, read here and nowhere else: the server's own settings above, and the few that point the app
 * elsewhere below. Each of those is read when it is asked for, not once at start: a test, or the demo, sets one
 * after the server is up.
 */
export const environment = (): NodeJS.ProcessEnv => process.env;

/** The release this server is (set by the release build); "dev" from a checkout. Read once. */
export const VERSION = process.env.AFFLATUS_VERSION?.trim() || "dev";

/** The environment's addresses and folders besides the server's own, raw as set (undefined when not). */
export const envSaid = {
  /** The address the browser reaches this server at, when a proxy stands in front of it. */
  publicUrl: () => process.env.PUBLIC_URL,
  /** The addresses of the reverse proxies on other machines whose X-Forwarded-Proto is believed (access-api.ts overHttps), comma-separated. */
  trustProxy: () => process.env.TRUST_PROXY,
  /** Civitai's address, for a stand-in site (the tests, the demo). */
  civitaiUrl: () => process.env.CIVITAI_URL,
  /** Hugging Face's address, for a stand-in site. */
  huggingfaceUrl: () => process.env.HUGGINGFACE_URL,
  /** Telegram's Bot API, for a stand-in site (the tests). */
  telegramUrl: () => process.env.TELEGRAM_URL,
  /** The start of a stand-in Discord webhook's address (the tests): a webhook under it is taken as Discord's. */
  discordUrl: () => process.env.DISCORD_URL,
  /** "1": no site on the internet is asked (the demo, a test); a stand-in set above still is. */
  pretendSites: () => process.env.AFFLATUS_PRETEND_SITES === "1",
  /** ComfyUI-Manager's model list, elsewhere. */
  modelListUrl: () => process.env.MODEL_LIST_URL,
  /** The Afflatus node pack's folder, elsewhere than in the checkout. */
  nodePackDir: () => process.env.NODE_PACK_DIR,
  /** The presets' folder, elsewhere than in the checkout. */
  presetsDir: () => process.env.PRESETS_DIR,
  /** ffmpeg and ffprobe, when they are not on the PATH. */
  ffmpeg: () => process.env.FFMPEG,
  ffprobe: () => process.env.FFPROBE,
  /** The address of Afflatus's latest release (GitHub's, unless set): a stand-in site in the tests, or a mirror. */
  updatesUrl: () => process.env.UPDATES_URL,
  /** How Afflatus was installed: "bundle" (set by the release's launcher), "docker" (by the image); anything else is the sources. */
  install: () => process.env.AFFLATUS_INSTALL,
  /** A bundle's own folder, the one the user unzipped (set by its launcher): versions/ and data/ are in it. */
  root: () => process.env.AFFLATUS_ROOT,
  /** The file written once the server listens, which tells the launcher this version started (R/versions/<v>/.started). */
  startedFile: () => process.env.AFFLATUS_STARTED_FILE,
  /** Windows' own folder, where its tar.exe is (updates.ts systemTar). */
  systemRoot: () => process.env.SystemRoot,
  /** "1": SQLite's statements run in a worker thread, not on the server's own (db.ts openSqlite). */
  sqliteWorker: () => process.env.AFFLATUS_SQLITE_WORKER === "1",
  /** RunPod's API, for a pretend RunPod (the demo, the tests). */
  runpodApi: () => process.env.RUNPOD_API_URL,
  /** How a pod's ComfyUI is reached, {id} and {port} in it: RunPod's proxy unless set (a pretend RunPod's pods). */
  runpodProxy: () => process.env.RUNPOD_PROXY,
  /** The image a GPU deployed from Afflatus runs with the Afflatus template, when not the one this version names (a test build). */
  podImage: () => process.env.AFFLATUS_POD_IMAGE,
  /** "1": the password and every session removed at this start (access.ts resetAccess), for an owner who lost both. */
  resetPassword: () => process.env.AFFLATUS_RESET_PASSWORD === "1",
};
