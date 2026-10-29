import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { plural, UPLOAD_MAX_BYTES } from "@afflatus/core";
import { z } from "zod";
import { assetLookup, mirrorItem, renameItem, silentItem, soundItem } from "./assets-api";
import { binItem, bulkItems, keepItem, restoreItem, type BulkDone } from "./assetsBin";
import { searchOf } from "./assetSearch";
import { takeIn } from "./assetUpload";
import type { Db, Tables } from "./db";
import { httpError } from "./errors";
import { createBody, editBody, folderDelete, folderEdit, folderNew, foldersList, itemsMove } from "./folders";
import { oneAtATime } from "./keyedLock";
import { NOT_IN_LIBRARY } from "./library";
import { seen, spends } from "./mcpForms";
import { mayQueueAll } from "./mcpRender";
import { tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { assertPublicUrl, fetchPublic } from "./outbound";
import { projectDelete, projectEdit, projectNew, projectsList, rootFolderOf } from "./projects";
import type { Services } from "./services";
import { clockOf, CUT_JOB } from "./timelineModel";
import { cutRange, rangeBody } from "./timelines-api";

/**
 * The library, from outside (MCP): searched, kept or not, to the bin and back, moved, renamed, its folders and projects,
 * a file brought in from an address, and the ranges and frames of its videos and sounds. Each through the web's own path
 * (assetsBin.ts, folders.ts, projects.ts, assetUpload.ts, timelines-api.ts cutRange), with its refusals and words.
 *
 * The bin is as far as anything goes: an item binned here comes back with restore until the user empties the bin, and
 * erasing for good is never offered. Nor is where a file is on the disk (Show in folder and Copy path stay in the web):
 * an item is said by its id, kind, name and facts, never its path.
 */

/** A library item as these tools say it: what it is and where it is filed, never where it is on the disk. */
function itemSaid(a: { id: string; kind: string; name: string; shownName?: string; width: number | null; height: number | null; durationMs: number | null; fps: number | null; hasSound: boolean; folderId: string | null; kept: boolean; inBin: boolean; createdAt: string; draftOf?: { id: string; name: string } | null; family?: string | null }) {
  return {
    item: a.id, kind: a.kind, name: a.name || a.shownName || "",
    ...(a.width ? { width: a.width, height: a.height } : {}),
    ...(a.kind !== "image" ? { durationMs: a.durationMs, ...(a.kind === "video" ? { fps: a.fps, hasSound: a.hasSound } : {}) } : {}),
    folder: a.folderId, kept: a.kept, inBin: a.inBin, createdAt: a.createdAt,
    ...(a.draftOf ? { draft: a.draftOf } : {}),
    ...(a.family ? { family: a.family } : {}),
  };
}

/** A library item by id, refused when there is none or it is not one the library shows (a mask, a Prompt kit file, a box's working picture). */
async function libraryItem(s: Services, id: string): Promise<Tables["assets"]> {
  const a = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
  if (!a) throw httpError(`There is no library item ${id}: search_library gives the ids.`, 404);
  if ((NOT_IN_LIBRARY as readonly string[]).includes(a.origin)) throw httpError(`${id} is not an item of the library (${a.origin === "kit" ? "a Prompt kit file: edit_kit_item changes it" : "a working file of a form"}).`);
  return a;
}

/** An item's name as the activity says it. */
const named = (a: Pick<Tables["assets"], "id" | "name">) => `“${a.name || a.id}”`;

const items = z.array(z.string().min(1)).min(1).max(500).describe("Library item ids (search_library).");

/** One item or several kept, unkept, binned or restored: one through its own route (refused with why), several as the bulk does (what something uses is left, and counted). */
async function onItems(ctx: ToolCtx, ids: string[], action: "keep" | "unkeep" | "bin" | "restore") {
  const { s } = ctx;
  const rows = await Promise.all(ids.map((id) => libraryItem(s, id)));
  const lookup = assetLookup(s);
  const verb = { keep: "Kept", unkeep: "Unkept", bin: "Binned", restore: "Restored" }[action];
  if (rows.length === 1) {
    const a = rows[0]!;
    if (action === "bin") await binItem(s, lookup, a.id);
    else if (action === "restore") await restoreItem(s, lookup, a.id);
    else await keepItem(s, lookup, a.id, action === "keep");
    ctx.said(`${verb} ${named(a)}`);
    return { changed: 1 };
  }
  const done: BulkDone = await bulkItems(s, lookup, { ids, action });
  ctx.said(`${verb} ${plural(done.changed, "item")}${done.inUse ? `, ${done.inUse} left as they were (in use)` : ""}`);
  return { ...done, ...(done.inUse ? { said: `${plural(done.inUse, "item")} left as they were: something still uses them (a take on a timeline, a person's picture, a draft's input).` } : {}) };
}

const searchLibrary = tool({
  name: "search_library",
  scope: "look",
  title: "Search the library",
  description: "The library a page at a time, newest first, as the Studio's grid lists it: by words (in the name or in what was written to make it; typos forgiven), kind, folder or project, kept or not, the bin, the model family, model file or LoRA it was made with, the draft that made it, made since. Each item: id, kind, name, size, length, folder, kept, the draft and family it came from. view_item shows one.",
  input: {
    words: z.string().max(200).optional(),
    kind: z.enum(["image", "video", "audio"]).optional(),
    folder: z.string().optional().describe("A folder's id (list_places), or \"none\": what is in no folder."),
    project: z.string().optional().describe("A project's id (list_places), or \"none\": the Inbox."),
    kept: z.boolean().optional().describe("true: only what was kept; false: only what was not (it goes to the bin after its time)."),
    inBin: z.boolean().optional().describe("true: what is in the bin (restore brings it back)."),
    family: z.string().optional().describe("Made with this model family (list_forms › family)."),
    model: z.string().max(500).optional().describe("Made with this model file."),
    lora: z.string().max(500).optional().describe("Made with this LoRA."),
    draft: z.string().max(64).optional().describe("Made by this draft (list_drafts)."),
    since: z.string().max(40).optional().describe("Made since this moment (ISO date or time)."),
    sort: z.enum(["new", "old", "name", "size"]).optional().describe("Newest first (the default), oldest, by name, by size. Words sort by match."),
    limit: z.number().int().min(1).max(100).optional().describe("How many (30 when left out)."),
    after: z.string().optional().describe("The `next` of the page before."),
  },
  async run(a, ctx) {
    const page = await searchOf(ctx.s).list({
      q: a.words, kind: a.kind, folder: a.folder, project: a.project, family: a.family, model: a.model, lora: a.lora, draft: a.draft, since: a.since, sort: a.sort,
      ...(a.kept !== undefined ? { kept: a.kept ? "1" : "0" } : {}), ...(a.inBin ? { bin: "1" } : {}),
      limit: a.limit ?? 30, after: a.after,
    });
    ctx.said(`Searched the library${a.words ? ` for “${a.words}”` : ""}: ${plural(page.items.length, "item")}`);
    return { items: page.items.map(itemSaid), next: page.next };
  },
});

const keep = tool({
  name: "keep",
  scope: "make",
  title: "Keep",
  description: "Keep items, as the library's Keep does: they never go to the bin on their own (what nobody kept goes there after its time, Settings › Storage). Filing an item in a folder keeps it too.",
  input: { items },
  run: ({ items: ids }, ctx) => onItems(ctx, ids, "keep"),
});

const unkeep = tool({
  name: "unkeep",
  scope: "make",
  title: "Unkeep",
  description: "Take Keep off items: their time before the bin starts now. What something still uses (a take on a timeline, a person's picture, a draft's input) stays kept, said so.",
  input: { items },
  run: ({ items: ids }, ctx) => onItems(ctx, ids, "unkeep"),
});

const bin = tool({
  name: "bin",
  scope: "make",
  title: "To the bin",
  description: "Put items in the bin, as the library's Delete does. Nothing is erased: restore brings them back until the user empties the bin in Afflatus. Erasing for good is never offered through MCP. What something still uses (a take on a timeline, a person's picture, a draft's input) is refused, said so.",
  input: { items },
  run: ({ items: ids }, ctx) => onItems(ctx, ids, "bin"),
});

const restore = tool({
  name: "restore",
  scope: "make",
  title: "Restore",
  description: "Bring items back from the bin (search_library with inBin lists it), unkept: their time before the bin starts again.",
  input: { items },
  run: ({ items: ids }, ctx) => onItems(ctx, ids, "restore"),
});

const move = tool({
  name: "move",
  scope: "make",
  title: "Move",
  description: "File items in a folder (or the top of a project, its root folder), or take them out of any folder (folder null). Filing keeps them. A timeline whose takes all move follows them, unless its folder was chosen by hand.",
  input: {
    items,
    folder: z.string().nullable().optional().describe("A folder's id (list_places), or null: in no folder."),
    project: z.string().optional().describe("A project's id: into its root folder."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    if (a.folder === undefined && !a.project) throw httpError("Say where to: a folder (or null for none), or a project.");
    if (a.folder !== undefined && a.project) throw httpError("A folder or a project, not both.");
    await Promise.all(a.items.map((id) => libraryItem(s, id)));
    let folder = a.folder ?? null;
    if (a.project) {
      if (!(await s.db.selectFrom("projects").select("id").where("id", "=", a.project).executeTakeFirst())) throw httpError("There is no such project: list_places gives the ids.", 404);
      folder = await rootFolderOf(s.db, a.project);
      if (!folder) throw httpError("This project has no root folder to file items in: give it one in Afflatus's Projects panel, or name one of its folders.");
    }
    const done = await itemsMove(s, { ids: a.items, folderId: folder });
    const to = folder ? (await s.db.selectFrom("folders").select("name").where("id", "=", folder).executeTakeFirst())?.name ?? folder : null;
    ctx.said(`Moved ${plural(a.items.length, "item")} ${to ? `into “${to}”` : "out of any folder"}`);
    return { ...done, folder };
  },
});

const rename = tool({
  name: "rename",
  scope: "make",
  title: "Rename",
  description: "A name of the user's own for an item: what the library shows and the search goes by (empty: the name worked out from how it was made). The file keeps its own.",
  input: { item: z.string().min(1), name: z.string().trim().max(200) },
  async run({ item, name }, ctx) {
    const a = await libraryItem(ctx.s, item);
    const view = await renameItem(ctx.s, assetLookup(ctx.s), a.id, name);
    ctx.said(`Renamed ${named(a)} to “${name}”`);
    return itemSaid(view);
  },
});

const listPlaces = tool({
  name: "list_places",
  scope: "look",
  title: "Folders and projects",
  description: "The projects (with how many drafts, timelines and items each holds, archived or not), the Inbox, and the folders (nested; each one's project and item count; linked: a directory of the user's disk).",
  async run(_args, ctx) {
    const [projects, folders] = await Promise.all([projectsList(ctx.s), foldersList(ctx.s)]);
    ctx.said(`Listed the places: ${plural(projects.items.length, "project")}, ${plural(folders.items.length, "folder")}`);
    return {
      projects: projects.items.map((p) => ({ id: p.id, name: p.name, rootFolder: p.folderId, archived: Boolean(p.archivedAt), drafts: p.drafts, timelines: p.timelines, items: p.assets })),
      inbox: projects.inbox,
      folders: folders.items.map((f) => ({ id: f.id, name: f.name, parent: f.parentId, project: f.projectId, items: f.count, ...(f.path ? { linked: true } : {}) })),
    };
  },
});

const newFolder = tool({
  name: "new_folder",
  scope: "make",
  title: "New folder",
  description: "A new folder: at the top of a project (or the Inbox), or inside another folder (then in that one's project). Inside a linked folder it is a new directory on the disk.",
  input: {
    name: z.string().trim().min(1).max(120),
    parent: z.string().optional().describe("A folder's id to make it in (list_places)."),
    project: z.string().optional().describe("Of a folder at the top: its project's id; left out: the Inbox."),
  },
  async run(a, ctx) {
    const f = await folderNew(ctx.s, createBody.parse({ name: a.name, parentId: a.parent ?? null, project: a.parent ? undefined : a.project ?? null }));
    ctx.said(`Made the folder “${f.name}”`);
    return { id: f.id, name: f.name, parent: f.parentId, project: f.projectId };
  },
});

const editFolder = tool({
  name: "edit_folder",
  scope: "make",
  title: "Rename or move a folder",
  description: "A folder renamed, moved into another (never into itself), to the top (parent null), or to the top of another project. Its folders, items and timelines go with it. A linked folder's directories are renamed and moved on the disk, not here.",
  input: {
    folder: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    parent: z.string().nullable().optional().describe("Another folder's id, or null: the top of its project."),
    project: z.string().nullable().optional().describe("At the top: the project it goes to (null: the Inbox)."),
  },
  async run(a, ctx) {
    const was = await ctx.s.db.selectFrom("folders").select("name").where("id", "=", a.folder).executeTakeFirst();
    await folderEdit(ctx.s, a.folder, editBody.parse({ name: a.name, parentId: a.parent, project: a.project }));
    ctx.said(`Changed the folder “${was?.name ?? a.folder}”${a.name ? `: now “${a.name}”` : ""}`);
    return { ok: true };
  },
});

const newProject = tool({
  name: "new_project",
  scope: "make",
  title: "New project",
  description: "A new project, with its root folder of the same name.",
  input: { name: z.string().trim().min(1).max(120) },
  async run({ name }, ctx) {
    const p = await projectNew(ctx.s, name);
    ctx.said(`Made the project “${p.name}”`);
    return { id: p.id, name: p.name, rootFolder: p.folderId };
  },
});

const renameProject = tool({
  name: "rename_project",
  scope: "make",
  title: "Rename a project",
  description: "A project renamed; its root folder follows (unless it is a directory of the disk).",
  input: { project: z.string().min(1), name: z.string().trim().min(1).max(120) },
  async run({ project, name }, ctx) {
    const p = await projectEdit(ctx.s, project, { name });
    ctx.said(`Renamed a project to “${p.name}”`);
    return { id: p.id, name: p.name };
  },
});

/** The name a file from an address gets when none is given: the last part of its path, without its extension. */
const nameOfUrl = (url: URL) => decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 200);

/**
 * What an agent may bring in from addresses (I2 of the 2026-10-27 review): one import at a time per token, each at most
 * `file` bytes (an upload from the page takes 4 GB, which an agent repeating itself turns into a full disk), and at most
 * `day` bytes a token over the last 24 hours, counted as the bytes come (a refused or failed import
 * counts what it fetched). Kept in memory: a restart starts the day again, and a token cannot restart Afflatus.
 */
export const importLimits = { file: 2 ** 30, day: 8 * 2 ** 30 };
const DAY_MS = 24 * 3600_000;
interface Imports { busy: Set<string>; fetched: Map<string, Array<{ at: number; bytes: number }>>; sent: Map<string, Array<{ at: number; bytes: number }>> }
/** Each database's own (tests run several apps at once). */
const importsOf = new WeakMap<Db, Imports>();
function imports(db: Db): Imports {
  let i = importsOf.get(db);
  if (!i) importsOf.set(db, (i = { busy: new Set(), fetched: new Map(), sent: new Map() }));
  return i;
}
/** What a token fetched (or sent, `of` "sent") over the last 24 hours, the older entries let go. */
function fetchedToday(i: Imports, token: string, at = Date.now(), of: "fetched" | "sent" = "fetched"): number {
  const kept = (i[of].get(token) ?? []).filter((x) => at - x.at < DAY_MS);
  i[of].set(token, kept);
  return kept.reduce((n, x) => n + x.bytes, 0);
}
const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1).replace(/\.0$/, "")} GB`;

const importFromUrl = tool({
  name: "import_from_url",
  scope: "make",
  title: "Import from an address",
  description: "A picture, a video or a sound at a public address (http or https) brought into the library, as an upload from the computer is: read from its bytes, kept, in a folder or a project's root folder when one is named. Addresses inside the user's network are refused, as Afflatus refuses them everywhere. One at a time per token, each at most 1 GB, and at most 8 GB a token over 24 hours.",
  input: {
    url: z.string().trim().url().max(2000),
    name: z.string().trim().max(200).optional().describe("Its name in the library; left out: the file's name."),
    folder: z.string().optional().describe("A folder's id (list_places)."),
    project: z.string().optional().describe("A project's id: into its root folder."),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    const url = assertPublicUrl(a.url);
    const mine = imports(s.db);
    if (mine.busy.has(token.id)) throw refusal("This token is already importing a file: one at a time. Wait for it to end, then import the next.");
    const left = importLimits.day - fetchedToday(mine, token.id);
    if (left <= 0) throw refusal(`This token has fetched ${gb(importLimits.day)} over the last 24 hours, the most it may: import again later, or the user uploads it in Afflatus.`);
    // the smaller of an import's most and what is left of the day: a file past either stops as it comes
    const most = Math.min(importLimits.file, UPLOAD_MAX_BYTES, left);
    const tooLarge = (size?: number) => httpError(most < importLimits.file
      ? `This file${size ? ` is ${gb(size)}, which` : ""} goes past what this token may still fetch today (${gb(left)} of ${gb(importLimits.day)} a day).`
      : `This file is ${size ? gb(size) : `larger than ${gb(most)}`}: an agent imports at most ${gb(most)} a file. A larger one the user uploads in Afflatus.`, 413);
    mine.busy.add(token.id);
    let bytes = 0;
    try {
      const res = await fetchPublic(url.href, { headers: { "User-Agent": "afflatus", Accept: "image/*,video/*,audio/*,*/*" }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw httpError(`${url.hostname} answered ${res.status}: nothing was imported.`, 502);
      }
      const said = Number(res.headers.get("content-length") ?? 0);
      if (said > most) {
        await res.body.cancel().catch(() => {});
        throw tooLarge(said);
      }
      const dir = await mkdtemp(join(tmpdir(), "afflatus-import-"));
      try {
        const path = join(dir, "file");
        // counted as it comes: an address that says no length (or a wrong one) is held to the most all the same
        const count = new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length;
            done(bytes > most ? tooLarge() : null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), count, createWriteStream(path));
        const view = await takeIn(s, assetLookup(s), { path, dir, bytes }, { name: a.name ?? nameOfUrl(url), folder: a.folder, project: a.project });
        ctx.said(`Imported ${view.name ? `“${view.name}”` : "a file"} from ${url.hostname}`);
        return itemSaid(view);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      mine.busy.delete(token.id);
      if (bytes) mine.fetched.get(token.id)!.push({ at: Date.now(), bytes });
    }
  },
});

/**
 * What an agent may send as a file's bytes (upload): one file at a time per token (an import from an address counts too),
 * each at most `file` bytes, and at most `day` bytes a token over the last 24 hours. A file sent whole in one call as
 * base64 is held in memory as it is read, a third larger: /mcp takes a call that large only once its token is known
 * (mcp.ts). Kept in memory, as importLimits.
 */
export const uploadLimits = { file: 16 * 2 ** 20, day: 2 ** 30 };
/** The most a file sent to upload weighs, as /mcp makes room for it. */
export const UPLOAD_MOST = uploadLimits.file;
/** A size as these tools say it: in MB, or in kB under one. */
const sized = (bytes: number) => (bytes < 2 ** 20 ? `${Math.ceil(bytes / 1024)} kB` : `${Math.round(bytes / 2 ** 20)} MB`);

const upload = tool({
  name: "upload",
  scope: "make",
  title: "Upload a file",
  description: `A picture, a video or a sound sent as its bytes (base64; a data: address is taken too) brought into the library, as an upload from the computer is: what it is read from its bytes (PNG, JPEG, WebP; the video and sound containers ffmpeg reads, never a playlist or a manifest that names other files), kept, in a folder or a project's root folder when one is named. Then its id goes where library items go: edit_draft's references and pictures, edit_kit_item's pictures and voice, a timeline's clips. One at a time per token, each at most ${sized(UPLOAD_MOST)}, and at most ${gb(uploadLimits.day)} a token over 24 hours: a larger file, import_from_url from an address, or the user uploads it in Afflatus.`,
  input: {
    data: z.string().min(1).max(Math.ceil((UPLOAD_MOST * 4) / 3) + 200).describe("The file's bytes as base64."),
    name: z.string().trim().max(200).optional().describe("Its name in the library; left out, worked out from how it is used."),
    folder: z.string().optional().describe("A folder's id (list_places)."),
    project: z.string().optional().describe("A project's id: into its root folder."),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    const text = a.data.replace(/^data:[\w.+-]+\/[\w.+-]+(;[\w=.+-]+)*;base64,/i, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw httpError("data is not base64: send the file's bytes as base64, nothing around them.");
    const bytes = Buffer.from(text, "base64");
    if (!bytes.length) throw httpError("data holds no bytes.");
    const mine = imports(s.db);
    if (mine.busy.has(token.id)) throw refusal("This token is already bringing a file in: one at a time. Wait for it to end, then send the next.");
    if (bytes.length > uploadLimits.file) throw httpError(`This file is ${sized(bytes.length)}: an agent uploads at most ${sized(uploadLimits.file)} a file. A larger one, import_from_url from an address, or the user uploads it in Afflatus.`, 413);
    const left = uploadLimits.day - fetchedToday(mine, token.id, Date.now(), "sent");
    if (bytes.length > left) throw refusal(`This file goes past what this token may still upload today (${sized(Math.max(0, left))} of ${gb(uploadLimits.day)} a day): upload it later, or the user uploads it in Afflatus.`);
    mine.busy.add(token.id);
    // counted as it is taken: what was sent was sent, taken in or refused
    mine.sent.get(token.id)!.push({ at: Date.now(), bytes: bytes.length });
    const dir = await mkdtemp(join(tmpdir(), "afflatus-upload-"));
    try {
      const path = join(dir, "file");
      await writeFile(path, bytes);
      const view = await takeIn(s, assetLookup(s), { path, dir, bytes: bytes.length }, { name: a.name, folder: a.folder, project: a.project });
      ctx.said(`Uploaded ${view.name ? `“${view.name}”` : `a ${view.kind === "image" ? "picture" : view.kind === "audio" ? "sound" : "video"}`} (${sized(bytes.length)})`);
      return itemSaid(view);
    } finally {
      mine.busy.delete(token.id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

/** A video or a sound of the library, refused for a picture. */
async function timed(s: Services, id: string, videoOnly = false): Promise<Tables["assets"]> {
  const a = await libraryItem(s, id);
  if (a.kind === "image" || (videoOnly && a.kind !== "video")) throw httpError(`${named(a)} is ${a.kind === "image" ? "a picture" : "a sound"}: this takes a video${videoOnly ? "" : " or a sound"}.`);
  return a;
}

const cutRangeTool = tool({
  name: "cut_range",
  scope: "make",
  title: "Cut a range",
  description: "A range of a video or a sound, as Trim does it: copy (the range as a new item, this one kept as it is), split (the range and what is before and after it as new items) or remove (what is left without the range as a new item); of a video, slow (the range slowed `factor` times, 2 or 4, as a new item). Split and remove put this one in the bin once they are done (restore brings it back); one that something still uses is refused. A job of the queue: copy, split and remove are ffmpeg on this computer, no GPU (`even` evens out a sound's loudness); slow is RIFE on the GPU where ComfyUI has it, so it is held to the token's limits as a render is (renders an hour, rented pods only with Spend and within its cap). Answers the job (job follows it).",
  input: {
    item: z.string().min(1),
    startMs: z.number().min(0),
    endMs: z.number().min(0),
    action: z.enum(["copy", "split", "remove", "slow"]),
    factor: z.union([z.literal(2), z.literal(4)]).optional().describe("Of slow: how many times slower (2 when left out)."),
    even: z.boolean().optional().describe("Of a sound: its loudness evened out."),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    const item = await timed(s, a.item, a.action === "slow");
    const span = `${clockOf(a.startMs)}–${clockOf(a.endMs)}`;
    if (a.action === "slow") {
      const factor = a.factor ?? 2;
      const body = rangeBody.parse({ startMs: a.startMs, endMs: a.endMs, action: "slow", factor });
      const at = await seen(s);
      // the checks and the queueing in one turn per token, as render's: a slow motion is a render when RIFE makes it
      return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
        const usd = await mayQueueAll(s, ctx, at, [{ recipe: CUT_JOB, input: { asset: item.id, startMs: a.startMs, endMs: a.endMs, action: "slow", factor }, takes: 1 }], { renders: 1 });
        const job = await cutRange(s, item.id, body, { mcpToken: token.id });
        ctx.said(`Slowed ${span} of ${named(item)} ×${factor}`);
        return {
          job: job.id, by: job.engine === "rife" ? "RIFE on the GPU" : "ffmpeg on this computer (this ComfyUI has no RIFE)",
          on: spends(ctx) ? "wherever the queue ends it first" : "the user's own machines (this token has no Spend)",
          ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}),
        };
      });
    }
    const job = await cutRange(s, item.id, rangeBody.parse({ startMs: a.startMs, endMs: a.endMs, action: a.action, ...(a.even ? { even: true } : {}) }));
    ctx.said(`${a.action === "copy" ? "Copied" : a.action === "split" ? "Split out" : "Removed"} ${span} of ${named(item)}`);
    return { job: job.id, ...(a.action !== "copy" ? { then: `${named(item)} goes to the bin once it is done; restore brings it back.` } : {}) };
  },
  // a slow motion is followed (RIFE renders it, minutes); a copy, split or remove is ffmpeg's few seconds, answered at once
  task: (a: { job: string; by?: string }) => (a.by ? { jobs: [a.job] } : null),
});

const findScenes = tool({
  name: "find_scenes",
  scope: "look",
  title: "Find the shots",
  description: "Where a video cuts between shots (ffmpeg's scene change, as Trim marks them): the moments in ms. extract_scenes copies each shot out.",
  input: { item: z.string().min(1) },
  async run({ item }, ctx) {
    const a = await timed(ctx.s, item, true);
    const { cuts } = await ctx.s.timelines.media.scenes(a.id);
    ctx.said(`Found ${plural(cuts.length + 1, "shot")} in ${named(a)}`);
    return { cuts, shots: cuts.length + 1, durationMs: a.duration_ms };
  },
});

const extractScenes = tool({
  name: "extract_scenes",
  scope: "make",
  title: "Extract every shot",
  description: "Every shot of a video copied out as its own video, as Trim's Extract every scene does (a shot under 0.2 s is left out). Jobs of the queue, no GPU; the video itself stays as it is.",
  input: { item: z.string().min(1) },
  async run({ item }, ctx) {
    const { s } = ctx;
    const a = await timed(s, item, true);
    const { cuts } = await s.timelines.media.scenes(a.id);
    const edges = [0, ...cuts, a.duration_ms ?? 0];
    const jobs: string[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      if (edges[i + 1]! - edges[i]! < 200) continue;
      jobs.push((await cutRange(s, a.id, rangeBody.parse({ startMs: edges[i]!, endMs: edges[i + 1]!, action: "copy" }))).id);
    }
    if (!jobs.length) throw httpError(`${named(a)} has no cut between shots to extract.`);
    ctx.said(`Copying ${plural(jobs.length, "shot")} of ${named(a)} to the library`);
    return { jobs };
  },
});

const saveFrame = tool({
  name: "save_frame",
  scope: "make",
  title: "Save a frame",
  description: "One frame of a video as a picture in the library, beside the video, as Save frame does: to open another clip on, or to cast a person from.",
  input: { item: z.string().min(1), atMs: z.number().min(0).describe("The moment, in ms from the start.") },
  async run({ item, atMs }, ctx) {
    const a = await timed(ctx.s, item, true);
    const frame = await ctx.s.timelines.media.frame(a, Math.min(atMs, Math.max(0, (a.duration_ms ?? atMs) - 1)));
    ctx.said(`Saved the frame at ${clockOf(atMs)} of ${named(a)}`);
    return itemSaid({ id: frame.id, kind: frame.kind, name: frame.name, width: frame.width, height: frame.height, durationMs: null, fps: null, hasSound: false, folderId: frame.folder_id, kept: frame.kept_at !== null, inBin: false, createdAt: frame.created_at });
  },
});

const extractSound = tool({
  name: "extract_sound",
  scope: "make",
  title: "The sound of a video",
  description: "A video's sound as a sound of its own in the library, beside it in its folder, kept (for a clip's sound, the music, a voice), as the library's Extract audio does. The video stays as it is. ffmpeg on this computer, no GPU.",
  input: { item: z.string().min(1) },
  async run({ item }, ctx) {
    const a = await timed(ctx.s, item, true);
    const made = await soundItem(ctx.s, assetLookup(ctx.s), a.id);
    ctx.said(`Took the sound of ${named(a)} out as a sound of its own`);
    return itemSaid(made);
  },
});

const removeSound = tool({
  name: "remove_sound",
  scope: "make",
  title: "A video without its sound",
  description: "A copy of a video without its sound, beside it in its folder, kept, as the library's Remove audio does: the same frames. The video itself stays as it is. ffmpeg on this computer, no GPU.",
  input: { item: z.string().min(1) },
  async run({ item }, ctx) {
    const a = await timed(ctx.s, item, true);
    const made = await silentItem(ctx.s, assetLookup(ctx.s), a.id);
    ctx.said(`Made ${named(a)} without its sound`);
    return itemSaid(made);
  },
});

const mirror = tool({
  name: "mirror",
  scope: "make",
  title: "Mirror a picture",
  description: "A picture mirrored left and right (horizontal) or top and bottom (vertical), as a new picture beside it in its folder, kept, as the library's Mirror does. The picture itself stays as it is. Say for a keyframe that faces the wrong way for the shot before it. No GPU.",
  input: { item: z.string().min(1), axis: z.enum(["horizontal", "vertical"]).optional().describe("horizontal (left and right; the default) or vertical (top and bottom).") },
  async run({ item, axis }, ctx) {
    const a = await libraryItem(ctx.s, item);
    if (a.kind !== "image") throw httpError(`${named(a)} is a ${a.kind === "video" ? "video" : "sound"}: only a picture is mirrored.`);
    const made = await mirrorItem(ctx.s, assetLookup(ctx.s), a.id, axis ?? "horizontal");
    ctx.said(`Mirrored ${named(a)} ${axis === "vertical" ? "top and bottom" : "left and right"}`);
    return itemSaid(made);
  },
});

const deleteFolder = tool({
  name: "delete_folder",
  scope: "make",
  title: "Delete a folder",
  description: "Delete a folder, as the Projects panel's Delete does: nothing in it is deleted. Its items and its folders move up one level (to the folder above it, or the top of its project); a project's root folder leaves the project with none. A folder linked to a directory of the user's disk is refused: unlinking stays in Afflatus.",
  input: { folder: z.string().min(1) },
  async run({ folder }, ctx) {
    const f = await folderDelete(ctx.s, folder, { unlink: false });
    ctx.said(`Deleted the folder “${f.name}”: what it held moved up`);
    return { deleted: f.id, name: f.name, movedTo: f.parent_id ?? (f.project_id ? "the top of its project" : "the top of the Inbox") };
  },
});

const archiveProject = tool({
  name: "archive_project",
  scope: "make",
  title: "Archive a project",
  description: "Archive a project, or bring it back (archived false), as the Projects panel's Archive does: an archived project leaves the rail and the lists, its pin goes; nothing in it moves or goes.",
  input: { project: z.string().min(1), archived: z.boolean().optional().describe("false: back from the archive; true when left out.") },
  async run({ project, archived }, ctx) {
    const p = await projectEdit(ctx.s, project, { archived: archived ?? true });
    ctx.said(`${archived === false ? "Brought back" : "Archived"} the project “${p.name}”`);
    return { id: p.id, name: p.name, archived: Boolean(p.archivedAt) };
  },
});

const deleteProject = tool({
  name: "delete_project",
  scope: "make",
  title: "Delete a project",
  description: "Delete a project, as the Projects panel's Delete does: its drafts, timelines and folders (with their items) go to the Inbox; nothing is removed. archive_project hides one instead.",
  input: { project: z.string().min(1) },
  async run({ project }, ctx) {
    const p = await projectDelete(ctx.s, project);
    ctx.said(`Deleted the project “${p.name}”: what it held is in the Inbox`);
    return { deleted: p.id, name: p.name, said: "Its drafts, timelines and folders are in the Inbox now." };
  },
});

const lookAgain = tool({
  name: "look_again",
  scope: "make",
  title: "Look again",
  description: "Read a linked folder's directory again, as its Look again does: files added, changed or gone on the disk since show in the library as they are. Reads the disk only; linking a directory stays in Afflatus.",
  input: { folder: z.string().min(1).describe("A linked folder's id (list_places: linked), or one of its folders.") },
  async run({ folder }, ctx) {
    const f = await ctx.s.db.selectFrom("folders").select(["id", "name"]).where("id", "=", folder).executeTakeFirst();
    if (!f) throw httpError("There is no such folder: list_places gives the ids.", 404);
    const read = await ctx.s.linked.scan(f.id);
    ctx.said(`Looked again at “${f.name}”: ${plural(read.files, "file")}`);
    return { folder: f.id, ...read };
  },
});

export const LIBRARY_TOOLS = [
  searchLibrary, keep, unkeep, bin, restore, move, rename, listPlaces, newFolder, editFolder, deleteFolder, newProject, renameProject, archiveProject, deleteProject, lookAgain,
  importFromUrl, upload, cutRangeTool, findScenes, extractScenes, saveFrame, extractSound, removeSound, mirror,
];
