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
  /** postgres://… ; empty = SQLite at <dataDir>/studai.db */
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // localhost only by default: listening on the network is a choice (it will require a password)
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number(env.PORT) || 8720,
    dataDir: resolve(env.DATA_DIR?.trim() || "data"),
    databaseUrl: env.DATABASE_URL?.trim() ?? "",
  };
}
