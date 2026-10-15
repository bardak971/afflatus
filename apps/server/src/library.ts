import type { Db } from "./db";

/**
 * What the library is, as the modules that list it (the search, the projects, the drafts, the command bar, the
 * prompt history) share it: kept here, apart from all of them, so that none of them imports another for it.
 */

/**
 * What is kept but not shown in the library: a painted mask, a picture uploaded for the Prompt kit, and a box's working
 * pictures (`scratch`: the frame of a video Make the picture reads, the pictures it makes from it until one is picked).
 */
export const NOT_IN_LIBRARY = ["mask", "kit", "scratch"] as const;
/** A scratch picture nothing uses is erased after this long: a box's round is picked from within the hour. */
export const SCRATCH_MS = 24 * 3600_000;

/** The ids of a project's folders, or of the folders in no project. */
export async function folderIdsOf(db: Db, project: string | "none"): Promise<string[]> {
  let q = db.selectFrom("folders").select("id");
  q = project === "none" ? q.where("project_id", "is", null) : q.where("project_id", "=", project);
  return (await q.execute()).map((f) => f.id);
}
