import { PostgresAdapter, type Kysely } from "kysely";

/** Whether a migration runs on Postgres: the few steps the two databases spell differently ask this. */
export const onPostgres = (db: Kysely<any>): boolean => db.getExecutor().adapter instanceof PostgresAdapter;
