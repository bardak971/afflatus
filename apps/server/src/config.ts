import { resolve } from "node:path";

/**
 * Two ways to run, chosen by the environment alone:
 *  - on one PC: nothing set. SQLite and files under DATA_DIR.
 *  - on a cluster: DATABASE_URL (Postgres) and, later, S3_* for the files.
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
    // localhost only by default: listening on the network is a choice. Afflatus has no login and none is planned: anyone
    // who reaches the port can use it, so HOST is opened only to a network where everyone is trusted
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
  /** Civitai's address, for a stand-in site (the tests, the demo). */
  civitaiUrl: () => process.env.CIVITAI_URL,
  /** Hugging Face's address, for a stand-in site. */
  huggingfaceUrl: () => process.env.HUGGINGFACE_URL,
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
};
