import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { newId, now, OWNER, type Db } from "./db";
import type { Services } from "./services";
import { NOT_IN_LIBRARY } from "./library";
import { unusedSize, unusedTakes } from "./timelineUnused";
import { unusedDrafts } from "./drafts";
import { readSettings, writeSettings } from "./settings";
import type { LibraryChange } from "./events";

/**
 * Projects: what drafts, timelines and folders are grouped under. A project has a root folder, where its
 * things land unless another folder of it is chosen; it can be archived (hidden with everything in it)
 * and deleted (its drafts, timelines and folders go to the Inbox, nothing is removed). What is in no
 * project is the Inbox.
 */

const name = z.string().trim().min(1).max(120);

/** A project's root folder id, when it has one that still exists. */
export async function rootFolderOf(db: Db, project: string | null | undefined): Promise<string | null> {
  if (!project) return null;
  const p = await db.selectFrom("projects").select("folder_id").where("id", "=", project).executeTakeFirst();
  if (!p?.folder_id) return null;
  const f = await db.selectFrom("folders").select("id").where("id", "=", p.folder_id).executeTakeFirst();
  return f?.id ?? null;
}

const treeQuery = z.object({ q: z.string().trim().max(100).optional(), kind: z.enum(["image", "video", "audio"]).optional() });

interface FolderNode { id: string; name: string; linked: boolean; /** The directory of a linked folder (the one that was linked: its sub-folders are under it). */ path?: string; /** A linked folder whose directory cannot be read now: moved, deleted, its disk not there. */ missing?: boolean; items: number; totalItems: number; bytes: number; createdAt: string; children: FolderNode[] }
/** `unusedTakes`, `unusedBytes`: its takes no clip plays and nothing else needs, and the size of their videos (timelineUnused.ts). */
type TimelineLeaf = { id: string; name: string; folderId: string | null; clips: number; durationMs: number; bytes: number; exported: boolean; unusedTakes: number; unusedBytes: number; createdAt: string; updatedAt: string };
type DraftLeaf = { id: string; title: string; name: string | null; recipe: string; createdAt: string; updatedAt: string };
/** `counts.unusedDrafts`: of its drafts, those with no prompt, no name and nothing made from them (unusedDrafts). `createdAt`: null for the Inbox. */
interface TreeGroup {
  id: string | null; kind: "inbox" | "project"; name: string; archived: boolean; rootFolderId: string | null; createdAt: string | null;
  counts: { drafts: number; unusedDrafts: number; timelines: number; items: number }; bytes: number; folders: FolderNode[]; timelines: TimelineLeaf[]; drafts?: DraftLeaf[];
}
/** The drafts of a group the tree shows when searching, at most. */
const TREE_DRAFTS = 50;

/**
 * Every project (and the Inbox) with its folders as a tree, its timelines and its counts and sizes: the projects panel. A
 * handful of grouped queries for all of it. `q`: only what matches, folders with the ancestors of a match, and the drafts that match.
 * `only`: the items counted and sized are only of that kind (pictures, videos or sounds).
 */
export async function projectsTree(s: Services, q?: string, only?: "image" | "video" | "audio") {
  const db = s.db;
  const needle = q ? q.toLowerCase() : "";
  const hit = (text: string | null | undefined) => Boolean(needle && text && text.toLowerCase().includes(needle));
  const projects = await db.selectFrom("projects").selectAll().where("owner_id", "=", OWNER).execute();
  const folders = await db.selectFrom("folders").select(["id", "parent_id", "name", "path", "project_id", "created_at"]).where("owner_id", "=", OWNER).execute();
  // the library's items (not in the bin, not a mask or a kit picture), by folder; the loose ones under null
  const byFolder = new Map(
    (await db.selectFrom("assets").select((eb) => ["folder_id", eb.fn.countAll().as("n"), eb.fn.sum<number>("bytes").as("b")]).where("deleted_at", "is", null).where("origin", "not in", NOT_IN_LIBRARY).$if(Boolean(only), (qb) => qb.where("kind", "=", only!)).groupBy("folder_id").execute())
      .map((r) => [r.folder_id, { n: Number(r.n), b: Number(r.b ?? 0) }]),
  );
  const total = await db.selectFrom("assets").select((eb) => eb.fn.sum<number>("bytes").as("b")).where("deleted_at", "is", null).executeTakeFirst();
  const draftCounts = new Map((await db.selectFrom("drafts").select((eb) => ["project_id", eb.fn.countAll().as("n")]).groupBy("project_id").execute()).map((r) => [r.project_id, Number(r.n)]));
  const unusedCounts = new Map<string | null, number>();
  for (const d of await unusedDrafts(db)) unusedCounts.set(d.project_id, (unusedCounts.get(d.project_id) ?? 0) + 1);
  const leaves = await s.timelines.leaves();
  const unused = await unusedTakes(db);
  const matching = needle
    ? (await db.selectFrom("drafts").select(["id", "title", "name", "recipe_id", "created_at", "updated_at", "project_id"]).orderBy("updated_at", "desc").execute()).filter((d) => hit(d.title) || hit(d.name))
    : [];

  const known = new Set(projects.map((p) => p.id));
  const groupOf = (project: string | null) => (project && known.has(project) ? project : null);
  const folderIds = new Set(folders.map((f) => f.id));
  const rootOf = (p: { folder_id: string | null }) => (p.folder_id && folderIds.has(p.folder_id) ? p.folder_id : null);
  const roots = new Set(projects.flatMap((p) => rootOf(p) ?? []));
  // the directories that were linked, and which of them cannot be read now (one look each, at the disk)
  const linkedRoots = folders.filter((f) => f.path && !folders.some((p) => p.id === f.parent_id && p.path));
  const missing = new Set((await Promise.all(linkedRoots.map(async (f) => ((await stat(f.path!).catch(() => null))?.isDirectory() ? null : f.id)))).filter((x): x is string => x !== null));
  const linkedRoot = new Set(linkedRoots.map((f) => f.id));
  const childrenOf = new Map<string | null, typeof folders>();
  for (const f of folders) childrenOf.set(f.parent_id, [...(childrenOf.get(f.parent_id) ?? []), f]);
  const byFolderName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  // a node and what is under it; a root folder is never a node (its project stands for it), a loop is cut
  const node = (f: (typeof folders)[number], seen: Set<string>): FolderNode => {
    seen.add(f.id);
    const children = (childrenOf.get(f.id) ?? []).filter((c) => !roots.has(c.id) && !seen.has(c.id)).sort(byFolderName).map((c) => node(c, seen));
    const own = byFolder.get(f.id) ?? { n: 0, b: 0 };
    return {
      id: f.id, name: f.name, linked: Boolean(f.path), ...(linkedRoot.has(f.id) ? { path: f.path!, ...(missing.has(f.id) ? { missing: true } : {}) } : {}), items: own.n, createdAt: f.created_at, children,
      totalItems: own.n + children.reduce((sum, c) => sum + c.totalItems, 0), bytes: own.b + children.reduce((sum, c) => sum + c.bytes, 0),
    };
  };
  // searching: a folder that matches, or holds one that does
  const prune = (nodes: FolderNode[]): FolderNode[] =>
    nodes.flatMap((n) => {
      const children = prune(n.children);
      return hit(n.name) || children.length ? [{ ...n, children }] : [];
    });
  const sizeOf = (ids: Array<string | null>) => ids.reduce((acc, id) => {
    const c = byFolder.get(id) ?? { n: 0, b: 0 };
    return { n: acc.n + c.n, b: acc.b + c.b };
  }, { n: 0, b: 0 });

  const group = (id: string | null, name: string, archived: boolean, rootFolderId: string | null, createdAt: string | null): TreeGroup | null => {
    const own = folders.filter((f) => groupOf(f.project_id) === id);
    // a project's: the children of its root, and its folders at the top (one that lost its root); the Inbox's: its folders at the top
    const top = id === null
      ? own.filter((f) => f.parent_id === null)
      : [...(rootFolderId ? (childrenOf.get(rootFolderId) ?? []).filter((c) => !roots.has(c.id)) : []), ...own.filter((f) => f.parent_id === null && f.id !== rootFolderId)];
    const seen = new Set<string>(rootFolderId ? [rootFolderId] : []);
    let nodes = [...new Map(top.map((f) => [f.id, f])).values()].sort(byFolderName).map((f) => node(f, seen));
    let timelines: TimelineLeaf[] = leaves.filter((t) => groupOf(t.projectId) === id).map(({ projectId: _, ...t }) => ({ ...t, ...unusedSize(unused.get(t.id)) }));
    // its items: in its folders, the root among them; the Inbox's, the loose ones too
    const size = sizeOf([...own.map((f) => f.id), ...(id === null ? [null] : [])]);
    const counts = { drafts: draftCounts.get(id) ?? 0, unusedDrafts: unusedCounts.get(id) ?? 0, timelines: timelines.length, items: size.n };
    const kind = id === null ? ("inbox" as const) : ("project" as const);
    if (!needle) return { id, kind, name, archived, rootFolderId, createdAt, counts, bytes: size.b, folders: nodes, timelines };
    nodes = prune(nodes);
    timelines = timelines.filter((t) => hit(t.name));
    const drafts = matching.filter((d) => groupOf(d.project_id) === id).slice(0, TREE_DRAFTS).map((d) => ({ id: d.id, title: d.title, name: d.name, recipe: d.recipe_id, createdAt: d.created_at, updatedAt: d.updated_at }));
    if (!nodes.length && !timelines.length && !drafts.length && !hit(name)) return null;
    return { id, kind, name, archived, rootFolderId, createdAt, counts, bytes: size.b, folders: nodes, timelines, drafts };
  };

  const byName = (a: { name: string }, b: { name: string }) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const ordered = [...projects.filter((p) => !p.archived_at).sort(byName), ...projects.filter((p) => p.archived_at).sort(byName)];
  const groups = [group(null, "Inbox", false, null, null), ...ordered.map((p) => group(p.id, p.name, Boolean(p.archived_at), rootOf(p), p.created_at))];
  return { totalBytes: Number(total?.b ?? 0), groups: groups.filter((g): g is TreeGroup => g !== null) };
}

/** A project that is gone or archived is no place to switch to: it leaves the rail's pins (the setting `pinnedProjects`). */
async function unpin(db: Db, id: string): Promise<void> {
  const pins = (await readSettings(db)).pinnedProjects;
  if (pins.includes(id)) await writeSettings(db, { pinnedProjects: pins.filter((p) => p !== id) });
}

/** A "library" event for a change of projects and folders alone: no item came, went or moved. */
const PLACES: LibraryChange = { change: "places" };

export function registerProjects(app: FastifyInstance, s: Services): void {
  const mustExist = async (id: string) => {
    const p = await s.db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
    if (!p) throw httpError("this project was not found", 404);
    return p;
  };
  /**
   * The drafts, timelines and items of every project, and of the Inbox (under null): one grouped query each, so the list costs the
   * same few statements however many projects there are (it is read on first load and after every library event). An item counts
   * for the project of its folder; a loose item, or one in a folder of no project, is the Inbox's.
   */
  const countsOf = async () => {
    const tally = (rows: Array<{ project_id: string | null; n: unknown }>) => new Map(rows.map((r) => [r.project_id, Number(r.n)]));
    const drafts = tally(await s.db.selectFrom("drafts").select((eb) => ["project_id", eb.fn.countAll().as("n")]).groupBy("project_id").execute());
    const timelines = tally(await s.db.selectFrom("timelines").select((eb) => ["project_id", eb.fn.countAll().as("n")]).groupBy("project_id").execute());
    const assets = tally(
      await s.db
        .selectFrom("assets")
        .leftJoin("folders", "folders.id", "assets.folder_id")
        .select((eb) => ["folders.project_id as project_id", eb.fn.countAll().as("n")])
        .where("assets.deleted_at", "is", null)
        // an item whose folder is gone counts nowhere, as it is in no list
        .where((eb) => eb.or([eb("assets.folder_id", "is", null), eb("folders.id", "is not", null)]))
        .groupBy("folders.project_id")
        .execute(),
    );
    return (id: string | null) => ({ drafts: drafts.get(id) ?? 0, timelines: timelines.get(id) ?? 0, assets: assets.get(id) ?? 0 });
  };
  type ProjectRow = { id: string; name: string; folder_id: string | null; archived_at: string | null; created_at: string; updated_at: string };
  const shape = (p: ProjectRow, counts: { drafts: number; timelines: number; assets: number }) => ({ id: p.id, name: p.name, folderId: p.folder_id, archivedAt: p.archived_at, createdAt: p.created_at, updatedAt: p.updated_at, ...counts });
  const view = async (p: ProjectRow) => shape(p, (await countsOf())(p.id));

  app.get("/api/projects", async () => {
    const rows = await s.db.selectFrom("projects").selectAll().where("owner_id", "=", OWNER).orderBy("archived_at").orderBy("name").execute();
    const counts = await countsOf();
    // the Inbox: what is in no project
    return { items: rows.map((p) => shape(p, counts(p.id))), inbox: counts(null) };
  });

  /** The projects panel: every project and the Inbox, their folders, timelines, counts and sizes (projectsTree). */
  app.get("/api/projects/tree", async (req) => {
    const query = treeQuery.parse(req.query);
    return projectsTree(s, query.q || undefined, query.kind);
  });

  /**
   * Give the project a root folder: `folderId`, one of its own folders that is not linked (put at its top), or, without it, a new
   * folder named after it. What was its root stays, as one of its folders.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/root", async (req) => {
    const body = z.strictObject({ folderId: z.string().optional() }).parse(req.body ?? {});
    const p = await mustExist(req.params.id);
    let folder = body.folderId;
    if (folder) {
      const f = await s.db.selectFrom("folders").selectAll().where("id", "=", folder).executeTakeFirst();
      if (!f || f.project_id !== p.id) throw httpError("That folder is not one of this project's.");
      if (f.path) throw httpError("A linked folder is a directory of your disk: it cannot be a project's root folder.");
      if (f.parent_id) await s.db.updateTable("folders").set({ parent_id: null }).where("id", "=", f.id).execute();
    } else {
      folder = newId();
      await s.db.insertInto("folders").values({ id: folder, owner_id: OWNER, parent_id: null, name: p.name, path: null, project_id: p.id, created_at: now() }).execute();
    }
    await s.db.updateTable("projects").set({ folder_id: folder, updated_at: now() }).where("id", "=", p.id).execute();
    s.queue.events.emit("library", PLACES);
    return view(await mustExist(p.id));
  });

  /** A new project, with its root folder of the same name. */
  app.post("/api/projects", async (req) => {
    const body = z.strictObject({ name }).parse(req.body);
    const at = now();
    const id = newId();
    const folder = { id: newId(), owner_id: OWNER, parent_id: null, name: body.name, path: null, project_id: id, created_at: at };
    await s.db.insertInto("folders").values(folder).execute();
    await s.db.insertInto("projects").values({ id, owner_id: OWNER, name: body.name, folder_id: folder.id, archived_at: null, created_at: at, updated_at: at }).execute();
    s.queue.events.emit("library", PLACES);
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
    if (body.archived) await unpin(s.db, p.id);
    // archived or back: what it holds leaves the lists or comes back; renamed, only the names of places change
    s.queue.events.emit("library", body.archived === undefined ? PLACES : undefined);
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
    await unpin(s.db, p.id);
    // its folders go to the Inbox, and every item in them changes project: every list is read
    s.queue.events.emit("library");
    return { ok: true };
  });
}
