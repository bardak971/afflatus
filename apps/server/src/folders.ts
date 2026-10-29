import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { newId, now, OWNER } from "./db";
import { foldersOf, type LibraryChange } from "./events";
import { oneAtATime } from "./keyedLock";
import { fromThisComputer } from "./hostCheck";
import { isLinked, whyNotLinkableFrom } from "./linked";
import type { Services } from "./services";
import { readSettings } from "./settings";

/** Folders, nested like directories. An item is in one folder or in none. */

const name = z.string().trim().min(1).max(120);
/** `project`: of a folder made at the top, which project it belongs to (null: the Inbox); a folder made inside another is in its project. */
export const createBody = z.strictObject({ name, parentId: z.string().nullable().default(null), project: z.string().nullable().optional() });
export const editBody = z.strictObject({ name: name.optional(), parentId: z.string().nullable().optional(), project: z.string().nullable().optional() });
export const moveBody = z.strictObject({ ids: z.array(z.string()).min(1).max(500), folderId: z.string().nullable() });

const all = (s: Services) => s.db.selectFrom("folders").selectAll().where("owner_id", "=", OWNER).execute();
const mustExist = async (s: Services, id: string) => {
  const f = await s.db.selectFrom("folders").selectAll().where("id", "=", id).executeTakeFirst();
  if (!f) throw httpError("this folder was not found", 404);
  return f;
};

/**
 * The tree changes one change at a time: a move is checked against the whole tree (never into itself), and two moved
 * into each other at once each passed the check and made a loop; a rename saved from the row as read put back the
 * parent a move had just changed.
 */
const inTurn = <T>(s: Services, work: () => Promise<T>) => oneAtATime(s.db, "folders", work);

/** The folders, with how many items each holds (GET /api/folders, MCP's list_places). */
export async function foldersList(s: Services) {
  const counts = await s.db
    .selectFrom("assets")
    .select((eb) => ["folder_id", eb.fn.countAll().as("n")])
    .where("deleted_at", "is", null)
    .where("folder_id", "is not", null)
    .groupBy("folder_id")
    .execute();
  const byFolder = new Map(counts.map((c) => [c.folder_id, Number(c.n)]));
  const rows = await all(s);
  return {
    items: rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        id: f.id, parentId: f.parent_id, name: f.name, count: byFolder.get(f.id) ?? 0, projectId: f.project_id,
        // linked to a directory of the disk; `root`: the one that was linked, not one of its sub-directories
        path: f.path, root: Boolean(f.path) && !rows.some((p) => p.id === f.parent_id && p.path),
      })),
  };
}

/** A new folder (POST /api/folders, MCP's new_folder): inside a linked folder, a new directory. */
export async function folderNew(s: Services, body: z.output<typeof createBody>) {
  const parent = body.parentId ? await mustExist(s, body.parentId) : null;
  // inside a linked folder, a new folder is a new directory
  const path = parent?.path ? await s.linked.makeFolder(parent, body.name) : null;
  const row = { id: newId(), owner_id: OWNER, parent_id: body.parentId, name: path ? path.split(/[\\/]/).pop()! : body.name, path, project_id: parent ? parent.project_id : body.project ?? null, created_at: now() };
  await s.db.insertInto("folders").values(row).execute();
  s.queue.events.emit("library", { change: "places" } satisfies LibraryChange);
  return { id: row.id, parentId: row.parent_id, name: row.name, count: 0, path: row.path, root: false, projectId: row.project_id };
}

/** A folder renamed, moved into another, or given another project at the top (PATCH /api/folders/:id, MCP's edit_folder), in the tree's turn. */
export const folderEdit = (s: Services, id: string, body: z.output<typeof editBody>) => inTurn(s, async () => {
  const folder = await mustExist(s, id);
  const rootLinked = folder.path && !(folder.parent_id && (await mustExist(s, folder.parent_id)).path);
  if (folder.path && (body.parentId !== undefined || !rootLinked)) throw httpError("This folder is a directory of your disk: rename or move it there, then press Look again. The linked folder itself can be given another name here.");
  if (body.parentId && (await mustExist(s, body.parentId)).path) throw httpError("A folder of the library cannot be moved into a linked folder. Make a new folder in it instead.");
  if (body.parentId) {
    // a folder cannot be moved into itself or into one of its own subfolders
    const rows = await all(s);
    for (let at: string | null = body.parentId; at; at = rows.find((f) => f.id === at)?.parent_id ?? null) {
      if (at === folder.id) throw httpError("a folder cannot be put inside itself");
    }
    await mustExist(s, body.parentId);
  }
  // a folder inside another is in its parent's project: given another one where it is, it and its timelines moved
  // there while the tree still showed it under its parent. It changes project by moving to the top of the other one
  if (body.parentId === undefined && folder.parent_id && body.project !== undefined && body.project !== folder.project_id) {
    throw httpError("A folder inside another one is in its parent's project: move it to the top of the other project instead.");
  }
  // its project: the new parent's when it moves, the one named when it is given one at the top
  const parentProject = body.parentId ? (await mustExist(s, body.parentId)).project_id : body.parentId === null ? (body.project !== undefined ? body.project : folder.project_id) : undefined;
  const project = parentProject !== undefined ? parentProject : body.project !== undefined ? body.project : folder.project_id;
  if (body.project !== undefined && body.project !== null && !(await s.db.selectFrom("projects").select("id").where("id", "=", body.project).executeTakeFirst())) throw httpError("this project was not found", 404);
  await s.db
    .updateTable("folders")
    .set({ name: body.name ?? folder.name, parent_id: body.parentId === undefined ? folder.parent_id : body.parentId, project_id: project })
    .where("id", "=", folder.id)
    .execute();
  // the folders under it follow
  if (project !== folder.project_id) {
    const rows = await all(s);
    const under = (id: string): string[] => rows.filter((f) => f.parent_id === id).flatMap((f) => [f.id, ...under(f.id)]);
    const ids = under(folder.id);
    if (ids.length) await s.db.updateTable("folders").set({ project_id: project }).where("id", "in", ids).execute();
    // the timelines filed in them follow: a timeline is in the project of its folder
    await s.db.updateTable("timelines").set({ project_id: project }).where("folder_id", "in", [folder.id, ...ids]).execute();
    s.queue.events.emit("timeline");
  }
  // renamed or moved within its project: only the places; into another project, what it holds changes project too
  s.queue.events.emit("library", project === folder.project_id ? ({ change: "places" } satisfies LibraryChange) : undefined);
  return { ok: true };
});

/**
 * A folder deleted (DELETE /api/folders/:id, MCP's delete_folder), in the tree's turn. What is in it is never deleted: its
 * items and subfolders move up one level. A linked folder is unlinked (nothing on the disk is touched), unless `unlink` is
 * false: MCP's, as linking a directory of the disk stays the user's, so does letting one go.
 */
export const folderDelete = (s: Services, id: string, o: { unlink?: boolean } = {}) => inTurn(s, async () => {
  const folder = await mustExist(s, id);
  if (folder.path) {
    // a linked folder is unlinked: nothing on the disk is touched. One of its sub-directories is not deleted from here.
    if (folder.parent_id && (await mustExist(s, folder.parent_id)).path) throw httpError("This folder is a directory of your disk: delete it there, then press Look again.");
    if (o.unlink === false) throw httpError("This folder is linked to a directory of the user's disk: unlinking it stays in Afflatus (the Projects panel's Unlink).");
    await s.linked.unlink(folder.id);
    return folder;
  }
  await s.db.transaction().execute(async (tx) => {
    await tx.updateTable("assets").set({ folder_id: folder.parent_id }).where("folder_id", "=", folder.id).execute();
    await tx.updateTable("folders").set({ parent_id: folder.parent_id }).where("parent_id", "=", folder.id).execute();
    // a project's root folder: the project keeps its things, without a root folder (they land at the top, in it)
    await tx.updateTable("projects").set({ folder_id: null }).where("folder_id", "=", folder.id).execute();
    await tx.deleteFrom("folders").where("id", "=", folder.id).execute();
  });
  s.queue.events.emit("library", { change: "moved", folders: [folder.id, folder.parent_id] } satisfies LibraryChange);
  return folder;
});

/** Items filed in a folder, or taken out of any (POST /api/assets/move, MCP's move). Filing something keeps it. */
export async function itemsMove(s: Services, body: z.output<typeof moveBody>) {
  const target = body.folderId ? await mustExist(s, body.folderId) : null;
  const items = await s.db.selectFrom("assets").selectAll().where("id", "in", body.ids).execute();
  if (target?.path) {
    // into a linked folder: each becomes a file in its directory (one that is a linked file already is moved on the disk)
    for (const a of items) await s.linked.into(a, target);
    s.queue.events.emit("library", { change: "moved", items: body.ids, folders: foldersOf(items, target.id), kept: true } satisfies LibraryChange);
    return { moved: items.length };
  }
  if (items.some((a) => isLinked(a.file_key))) {
    throw httpError("These are files of a linked folder: they live on your disk. Move them to another linked folder, or with your file manager.");
  }
  const moved = await s.db.updateTable("assets").set({ folder_id: body.folderId }).where("id", "in", body.ids).executeTakeFirst();
  // what someone took the trouble to file is not thrown away after a day
  if (body.folderId) await s.db.updateTable("assets").set({ kept_at: now() }).where("id", "in", body.ids).where("kept_at", "is", null).execute();
  const followed = await timelinesFollow(s, body.ids);
  // filed in a folder, they are kept too
  s.queue.events.emit("library", { change: "moved", items: body.ids, folders: foldersOf(items, body.folderId ?? null), kept: Boolean(body.folderId) } satisfies LibraryChange);
  if (followed) s.queue.events.emit("timeline");
  return { moved: Number(moved.numUpdatedRows), timelines: followed };
}

export function registerFolders(app: FastifyInstance, s: Services): void {

  app.get("/api/folders", async () => foldersList(s));

  // linking serves and bins what is in the folder: from another device, only what LINK_ROOTS names (linked.ts whyNotLinkableFrom)
  const fromHere = (req: FastifyRequest) => {
    const refused = whyNotLinkableFrom(fromThisComputer(req));
    if (refused) throw httpError(refused, 403);
  };

  /** Link a directory of the disk the server runs on: it becomes a folder, with its sub-directories as sub-folders. */
  app.post("/api/folders/link", async (req) => {
    fromHere(req);
    // `project`: the project it goes to the top of (null or left out: the Inbox)
    const body = z.strictObject({ path: z.string().trim().min(1).max(1000), name: z.string().trim().max(120).optional(), project: z.string().nullable().optional() }).parse(req.body);
    const row = await s.linked.link(body.path, body.name, (await readSettings(s.db)).comfyDir, body.project ?? null);
    // what it holds: `count` directly in it, `files` in it and its sub-folders
    const rows = await all(s);
    const under = (id: string): string[] => rows.filter((f) => f.parent_id === id).flatMap((f) => [f.id, ...under(f.id)]);
    const counted = (ids: string[]) => s.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).where("folder_id", "in", ids).where("deleted_at", "is", null).executeTakeFirst().then((r) => Number(r?.n ?? 0));
    return { id: row.id, parentId: null, name: row.name, count: await counted([row.id]), files: await counted([row.id, ...under(row.id)]), path: row.path, root: true, projectId: row.project_id };
  });

  /** A linked folder pointed at where its directory is now; read again at once. */
  app.post<{ Params: { id: string } }>("/api/folders/:id/relink", async (req) => {
    fromHere(req);
    await mustExist(s, req.params.id);
    const body = z.strictObject({ path: z.string().trim().min(1).max(1000) }).parse(req.body);
    const row = await s.linked.relink(req.params.id, body.path, (await readSettings(s.db)).comfyDir);
    return { id: row.id, name: row.name, path: row.path };
  });

  /** Read a linked folder's directory again. */
  app.post<{ Params: { id: string } }>("/api/folders/:id/scan", async (req) => {
    await mustExist(s, req.params.id);
    return s.linked.scan(req.params.id);
  });

  app.post("/api/folders", async (req) => folderNew(s, createBody.parse(req.body)));

  app.patch<{ Params: { id: string } }>("/api/folders/:id", async (req) => folderEdit(s, req.params.id, editBody.parse(req.body)));

  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    await folderDelete(s, req.params.id);
    return { ok: true };
  });

  /** File items in a folder, or take them out of any (folderId null). Filing something keeps it. */
  app.post("/api/assets/move", async (req) => itemsMove(s, moveBody.parse(req.body)));
}

/**
 * A timeline is listed in the folder its renders land in. When a move puts every take of a timeline into one
 * folder, the timeline follows it there (its next renders land there too), unless its folder was chosen by
 * hand. A timeline whose takes are spread over several folders stays where it is. Returns how many moved.
 */
async function timelinesFollow(s: Services, moved: string[]): Promise<number> {
  if (!moved.length) return 0;
  const touched = await s.db
    .selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").innerJoin("timelines", "timelines.id", "clips.timeline_id")
    .select(["timelines.id as id", "timelines.folder_id as folder"])
    .where("takes.asset_id", "in", moved).where("timelines.folder_chosen", "=", 0).distinct().execute();
  let count = 0;
  for (const t of touched) {
    const folders = await s.db
      .selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").innerJoin("assets", "assets.id", "takes.asset_id")
      .select("assets.folder_id as folder").where("clips.timeline_id", "=", t.id).where("assets.deleted_at", "is", null).distinct().execute();
    const only = folders.length === 1 ? folders[0]!.folder : undefined;
    if (!only || only === t.folder) continue;
    await s.db.updateTable("timelines").set({ folder_id: only }).where("id", "=", t.id).execute();
    count++;
  }
  return count;
}
