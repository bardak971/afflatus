import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId, now, OWNER, type Db } from "./db";
import type { Services } from "./services";

/**
 * Projects: what drafts, timelines and folders are grouped under. A project has a root folder, where its
 * things land unless another folder of it is chosen; it can be archived (hidden with everything in it)
 * and deleted (its drafts, timelines and folders go to the Inbox, nothing is removed). What is in no
 * project is the Inbox.
 */

const name = z.string().trim().min(1).max(120);
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** The ids of a project's folders, or of the folders in no project. */
export async function folderIdsOf(db: Db, project: string | "none"): Promise<string[]> {
  let q = db.selectFrom("folders").select("id");
  q = project === "none" ? q.where("project_id", "is", null) : q.where("project_id", "=", project);
  return (await q.execute()).map((f) => f.id);
}

/** A project's root folder id, when it has one that still exists. */
export async function rootFolderOf(db: Db, project: string | null | undefined): Promise<string | null> {
  if (!project) return null;
  const p = await db.selectFrom("projects").select("folder_id").where("id", "=", project).executeTakeFirst();
  if (!p?.folder_id) return null;
  const f = await db.selectFrom("folders").select("id").where("id", "=", p.folder_id).executeTakeFirst();
  return f?.id ?? null;
}

export function registerProjects(app: FastifyInstance, s: Services): void {
  const mustExist = async (id: string) => {
    const p = await s.db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
    if (!p) throw bad("this project was not found", 404);
    return p;
  };
  const view = async (p: { id: string; name: string; folder_id: string | null; archived_at: string | null; created_at: string; updated_at: string }) => {
    const count = async (table: "drafts" | "timelines") => Number((await s.db.selectFrom(table).select((eb) => eb.fn.countAll().as("n")).where("project_id", "=", p.id).executeTakeFirst())?.n ?? 0);
    const folders = await folderIdsOf(s.db, p.id);
    const assets = folders.length ? Number((await s.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).where("folder_id", "in", folders).where("deleted_at", "is", null).executeTakeFirst())?.n ?? 0) : 0;
    return { id: p.id, name: p.name, folderId: p.folder_id, archivedAt: p.archived_at, createdAt: p.created_at, updatedAt: p.updated_at, drafts: await count("drafts"), timelines: await count("timelines"), assets };
  };

  app.get("/api/projects", async () => {
    const rows = await s.db.selectFrom("projects").selectAll().where("owner_id", "=", OWNER).orderBy("archived_at").orderBy("name").execute();
    const items = [];
    for (const p of rows) items.push(await view(p));
    // the Inbox: what is in no project
    const inboxFolders = await folderIdsOf(s.db, "none");
    const inbox = {
      drafts: Number((await s.db.selectFrom("drafts").select((eb) => eb.fn.countAll().as("n")).where("project_id", "is", null).executeTakeFirst())?.n ?? 0),
      timelines: Number((await s.db.selectFrom("timelines").select((eb) => eb.fn.countAll().as("n")).where("project_id", "is", null).executeTakeFirst())?.n ?? 0),
      assets: Number((await s.db.selectFrom("assets").select((eb) => eb.fn.countAll().as("n")).where("deleted_at", "is", null).where((eb) => inboxFolders.length ? eb.or([eb("folder_id", "is", null), eb("folder_id", "in", inboxFolders)]) : eb("folder_id", "is", null)).executeTakeFirst())?.n ?? 0),
    };
    return { items, inbox };
  });

  /** A new project, with its root folder of the same name. */
  app.post("/api/projects", async (req) => {
    const body = z.strictObject({ name }).parse(req.body);
    const at = now();
    const id = newId();
    const folder = { id: newId(), owner_id: OWNER, parent_id: null, name: body.name, path: null, project_id: id, created_at: at };
    await s.db.insertInto("folders").values(folder).execute();
    await s.db.insertInto("projects").values({ id, owner_id: OWNER, name: body.name, folder_id: folder.id, archived_at: null, created_at: at, updated_at: at }).execute();
    s.queue.events.emit("library");
    return view(await mustExist(id));
  });

  /** Rename it (its root folder follows), or archive / unarchive it. */
  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const body = z.strictObject({ name: name.optional(), archived: z.boolean().optional() }).parse(req.body);
    const p = await mustExist(req.params.id);
    await s.db
      .updateTable("projects")
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.archived !== undefined ? { archived_at: body.archived ? now() : null } : {}), updated_at: now() })
      .where("id", "=", p.id)
      .execute();
    // the root folder keeps the project's name, unless it is a directory of the disk (its name is the directory's)
    if (body.name !== undefined && p.folder_id) await s.db.updateTable("folders").set({ name: body.name }).where("id", "=", p.folder_id).where("path", "is", null).execute();
    s.queue.events.emit("library");
    return view(await mustExist(p.id));
  });

  /** The project goes; its drafts, timelines and folders go to the Inbox. Nothing is removed. */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = await mustExist(req.params.id);
    await s.db.transaction().execute(async (tx) => {
      await tx.updateTable("folders").set({ project_id: null }).where("project_id", "=", p.id).execute();
      await tx.updateTable("drafts").set({ project_id: null }).where("project_id", "=", p.id).execute();
      await tx.updateTable("timelines").set({ project_id: null }).where("project_id", "=", p.id).execute();
      await tx.deleteFrom("projects").where("id", "=", p.id).execute();
    });
    s.queue.events.emit("library");
    return { ok: true };
  });
}
