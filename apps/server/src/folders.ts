import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId, now, OWNER } from "./db";
import type { Services } from "./services";

/** Folders, nested like directories. An item is in one folder or in none. */

const name = z.string().trim().min(1).max(120);
const createBody = z.strictObject({ name, parentId: z.string().nullable().default(null) });
const editBody = z.strictObject({ name: name.optional(), parentId: z.string().nullable().optional() });
const moveBody = z.strictObject({ ids: z.array(z.string()).min(1).max(500), folderId: z.string().nullable() });

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function registerFolders(app: FastifyInstance, s: Services): void {
  const all = () => s.db.selectFrom("folders").selectAll().where("owner_id", "=", OWNER).execute();
  const mustExist = async (id: string) => {
    const f = await s.db.selectFrom("folders").selectAll().where("id", "=", id).executeTakeFirst();
    if (!f) throw bad("this folder was not found", 404);
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
        .map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name, count: byFolder.get(f.id) ?? 0 })),
    };
  });

  app.post("/api/folders", async (req) => {
    const body = createBody.parse(req.body);
    if (body.parentId) await mustExist(body.parentId);
    const row = { id: newId(), owner_id: OWNER, parent_id: body.parentId, name: body.name, created_at: now() };
    await s.db.insertInto("folders").values(row).execute();
    s.queue.events.emit("library");
    return { id: row.id, parentId: row.parent_id, name: row.name, count: 0 };
  });

  app.patch<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    const body = editBody.parse(req.body);
    const folder = await mustExist(req.params.id);
    if (body.parentId) {
      // a folder cannot be moved into itself or into one of its own subfolders
      const rows = await all();
      for (let at: string | null = body.parentId; at; at = rows.find((f) => f.id === at)?.parent_id ?? null) {
        if (at === folder.id) throw bad("a folder cannot be put inside itself");
      }
      await mustExist(body.parentId);
    }
    await s.db
      .updateTable("folders")
      .set({ name: body.name ?? folder.name, parent_id: body.parentId === undefined ? folder.parent_id : body.parentId })
      .where("id", "=", folder.id)
      .execute();
    s.queue.events.emit("library");
    return { ok: true };
  });

  /** Deleting a folder never deletes what is in it: its items and subfolders move up one level. */
  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    const folder = await mustExist(req.params.id);
    await s.db.transaction().execute(async (tx) => {
      await tx.updateTable("assets").set({ folder_id: folder.parent_id }).where("folder_id", "=", folder.id).execute();
      await tx.updateTable("folders").set({ parent_id: folder.parent_id }).where("parent_id", "=", folder.id).execute();
      await tx.deleteFrom("folders").where("id", "=", folder.id).execute();
    });
    s.queue.events.emit("library");
    return { ok: true };
  });

  /** File items in a folder, or take them out of any (folderId null). Filing something keeps it. */
  app.post("/api/assets/move", async (req) => {
    const body = moveBody.parse(req.body);
    if (body.folderId) await mustExist(body.folderId);
    const moved = await s.db.updateTable("assets").set({ folder_id: body.folderId }).where("id", "in", body.ids).executeTakeFirst();
    // what someone took the trouble to file is not thrown away after a day
    if (body.folderId) await s.db.updateTable("assets").set({ kept_at: now() }).where("id", "in", body.ids).where("kept_at", "is", null).execute();
    s.queue.events.emit("library");
    return { moved: Number(moved.numUpdatedRows) };
  });
}
