import type { ExpressionBuilder } from "kysely";
import type { Db, Tables } from "./db";

/**
 * What the library is, as the modules that list it (the search, the projects, the drafts, the command bar, the
 * prompt history) share it: kept here, apart from all of them, so that none of them imports another for it.
 */

/**
 * What is kept but not shown in the library: a painted mask, a picture uploaded for the Prompt kit, and a box's working
 * pictures (`scratch`: the frame of a video Make the picture reads, the pictures it makes from it until one is picked).
 */
export const NOT_IN_LIBRARY = ["mask", "kit", "scratch"] as const;
/**
 * What the library shows of the items it reads, as one test every listing shares: none of the working files above, and no
 * version of a picture still waiting under its head (versions.ts), which shows in the head's strip until it is kept.
 */
export const inLibrary = (eb: ExpressionBuilder<Tables, "assets">) =>
  eb.and([eb("assets.origin", "not in", NOT_IN_LIBRARY), eb("assets.version_of", "is", null)]);
/** A scratch picture nothing uses is erased after this long: a box's round is picked from within the hour. */
export const SCRATCH_MS = 24 * 3600_000;

/** The ids of a project's folders, or of the folders in no project. */
export async function folderIdsOf(db: Db, project: string | "none"): Promise<string[]> {
  let q = db.selectFrom("folders").select("id");
  q = project === "none" ? q.where("project_id", "is", null) : q.where("project_id", "=", project);
  return (await q.execute()).map((f) => f.id);
}
