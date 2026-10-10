import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { newId, now, OWNER } from "./db";
import { foldersOf, type LibraryChange } from "./events";
import { isLinked } from "./linked";
import type { Services } from "./services";
import { readSettings } from "./settings";

/** Folders, nested like directories. An item is in one folder or in none. */

const name = z.string().trim().min(1).max(120);
/** `project`: of a folder made at the top, which project it belongs to (null: the Inbox); a folder made inside another is in its project. */
const createBody = z.strictObject({ name, parentId: z.string().nullable().default(null), project: z.string().nullable().optional() });
const editBody = z.strictObject({ name: name.optional(), parentId: z.string().nullable().optional(), project: z.string().nullable().optional() });
const moveBody = z.strictObject({ ids: z.array(z.string()).min(1).max(500), folderId: z.string().nullable() });


export function registerFolders(app: FastifyInstance, s: Services): void {
  const all = () => s.db.selectFrom("folders").selectAll().where("owner_id", "=", OWNER).execute();
  const mustExist = async (id: string) => {
    const f = await s.db.selectFrom("folders").selectAll().where("id", "=", id).executeTakeFirst();
    if (!f) throw httpError("this folder was not found", 404);
    return f;
  };

  app.get("/api/folders", async () => {
    const counts = await s.db
      .selectFrom("assets")
      .select((eb) => ["folder_id", eb.fn.countAll().as("n")])
      .where("deleted_at", "is", null)
      .where("folder_id", "is not", null)
      .groupBy("folder_id")
      .execute();
    const byFolder = new Map(counts.map((c) => [c.folder_id, Number(c.n)]));
    const rows = await all();
    return {
      items: rows
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({
          id: f.id, parentId: f.parent_id, name: f.name, count: byFolder.get(f.id) ?? 0, projectId: f.project_id,
          // linked to a directory of the disk; `root`: the one that was linked, not one of its sub-directories
          path: f.path, root: Boolean(f.path) && !rows.some((p) => p.id === f.parent_id && p.path),
        })),
    };
  });

  /** Link a directory of the disk the server runs on: it becomes a folder, with its sub-directories as sub-folders. */
  app.post("/api/folders/link", async (req) => {
    // `project`: the project it goes to the top of (null or left out: the Inbox)
    const body = z.strictObject({ path: z.string().trim().min(1).max(1000), name: z.string().trim().max(120).optional(), project: z.string().nullable().optional() }).parse(req.body);
    const row = await s.linked.link(body.path, body.name, (await readSettings(s.db)).comfyDir, body.project ?? null);
    // what it holds: `count` directly in it, `files` in it and its sub-folders
    const rows = await all();
    const under = (id: string): string[] => rows.filter((f) => f.parent_id === id).flatMap((f) => [f.id, ...under(f.id)]);
    const counted = (ids: string[]) => s.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).where("folder_id", "in", ids).where("deleted_at", "is", null).executeTakeFirst().then((r) => Number(r?.n ?? 0));
    return { id: row.id, parentId: null, name: row.name, count: await counted([row.id]), files: await counted([row.id, ...under(row.id)]), path: row.path, root: true, projectId: row.project_id };
  });

  /** A linked folder pointed at where its directory is now; read again at once. */
  app.post<{ Params: { id: string } }>("/api/folders/:id/relink", async (req) => {
    await mustExist(req.params.id);
    const body = z.strictObject({ path: z.string().trim().min(1).max(1000) }).parse(req.body);
    const row = await s.linked.relink(req.params.id, body.path, (await readSettings(s.db)).comfyDir);
    return { id: row.id, name: row.name, path: row.path };
  });

  /** Read a linked folder's directory again. */
  app.post<{ Params: { id: string } }>("/api/folders/:id/scan", async (req) => {
    await mustExist(req.params.id);
    return s.linked.scan(req.params.id);
  });

  app.post("/api/folders", async (req) => {
    const body = createBody.parse(req.body);
    const parent = body.parentId ? await mustExist(body.parentId) : null;
    // inside a linked folder, a new folder is a new directory
    const path = parent?.path ? await s.linked.makeFolder(parent, body.name) : null;
    const row = { id: newId(), owner_id: OWNER, parent_id: body.parentId, name: path ? path.split(/[\\/]/).pop()! : body.name, path, project_id: parent ? parent.project_id : body.project ?? null, created_at: now() };
    await s.db.insertInto("folders").values(row).execute();
    s.queue.events.emit("library", { change: "places" } satisfies LibraryChange);
    return { id: row.id, parentId: row.parent_id, name: row.name, count: 0, path: row.path, root: false, projectId: row.project_id };
  });

  app.patch<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    const body = editBody.parse(req.body);
    const folder = await mustExist(req.params.id);
    const rootLinked = folder.path && !(folder.parent_id && (await mustExist(folder.parent_id)).path);
    if (folder.path && (body.parentId !== undefined || !rootLinked)) throw httpError("This folder is a directory of your disk: rename or move it there, then press Look again. The linked folder itself can be given another name here.");
    if (body.parentId && (await mustExist(body.parentId)).path) throw httpError("A folder of the library cannot be moved into a linked folder. Make a new folder in it instead.");
    if (body.parentId) {
      // a folder cannot be moved into itself or into one of its own subfolders
      const rows = await all();
      for (let at: string | null = body.parentId; at; at = rows.find((f) => f.id === at)?.parent_id ?? null) {
        if (at === folder.id) throw httpError("a folder cannot be put inside itself");
      }
      await mustExist(body.parentId);
    }
    // its project: the new parent's when it moves, the one named when it is given one at the top
    const parentProject = body.parentId ? (await mustExist(body.parentId)).project_id : body.parentId === null ? (body.project !== undefined ? body.project : folder.project_id) : undefined;
    const project = parentProject !== undefined ? parentProject : body.project !== undefined ? body.project : folder.project_id;
    if (body.project !== undefined && body.project !== null && !(await s.db.selectFrom("projects").select("id").where("id", "=", body.project).executeTakeFirst())) throw httpError("this project was not found", 404);
    await s.db
      .updateTable("folders")
      .set({ name: body.name ?? folder.name, parent_id: body.parentId === undefined ? folder.parent_id : body.parentId, project_id: project })
      .where("id", "=", folder.id)
      .execute();
    // the folders under it follow
    if (project !== folder.project_id) {
      const rows = await all();
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

  /** Deleting a folder never deletes what is in it: its items and subfolders move up one level. */
  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    const folder = await mustExist(req.params.id);
    if (folder.path) {
      // a linked folder is unlinked: nothing on the disk is touched. One of its sub-directories is not deleted from here.
      if (folder.parent_id && (await mustExist(folder.parent_id)).path) throw httpError("This folder is a directory of your disk: delete it there, then press Look again.");
      await s.linked.unlink(folder.id);
      return { ok: true };
    }
    await s.db.transaction().execute(async (tx) => {
      await tx.updateTable("assets").set({ folder_id: folder.parent_id }).where("folder_id", "=", folder.id).execute();
      await tx.updateTable("folders").set({ parent_id: folder.parent_id }).where("parent_id", "=", folder.id).execute();
      // a project's root folder: the project keeps its things, without a root folder (they land at the top, in it)
      await tx.updateTable("projects").set({ folder_id: null }).where("folder_id", "=", folder.id).execute();
      await tx.deleteFrom("folders").where("id", "=", folder.id).execute();
    });
    s.queue.events.emit("library", { change: "moved", folders: [folder.id, folder.parent_id] } satisfies LibraryChange);
    return { ok: true };
  });

  /** File items in a folder, or take them out of any (folderId null). Filing something keeps it. */
  app.post("/api/assets/move", async (req) => {
    const body = moveBody.parse(req.body);
    const target = body.folderId ? await mustExist(body.folderId) : null;
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
  });
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
