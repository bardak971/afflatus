import type { Db } from "./db";

/**
 * What the library is, as the modules that list it (the search, the projects, the drafts, the command bar, the
 * prompt history) share it: kept here, apart from all of them, so that none of them imports another for it.
 */

/** What is kept but not shown in the library: a painted mask, a picture uploaded for the Prompt kit. */
export const NOT_IN_LIBRARY = ["mask", "kit"] as const;

/** The ids of a project's folders, or of the folders in no project. */
export async function folderIdsOf(db: Db, project: string | "none"): Promise<string[]> {
  let q = db.selectFrom("folders").select("id");
  q = project === "none" ? q.where("project_id", "is", null) : q.where("project_id", "=", project);
  return (await q.execute()).map((f) => f.id);
}
