import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Selectable } from "kysely";
import { tensorsOf, architectureOf } from "@afflatus/comfy";
import { baseName, fileKey, isModelFile, kindOfFolder, type InputSpec } from "@afflatus/core";
import { FAMILY_BASES } from "./browse";
import { civitaiGet } from "./civitai";
import { now, type Tables } from "./db";
import { httpError } from "./errors";
import { asideRoot, erase, moveBack, moveNoClobber, moveOut, systemBin, Taken, type BinFinder, type Place } from "./modelBin";
import { filesIn, HASHED_FOLDERS } from "./modelHashes";
import { insideDir, modelDirsSaid } from "./modelFiles";
import { nameOf } from "./modelPages";
import { setsWithFiles } from "./modelSets";
import { chosenFiles, readUses, usedKey } from "./modelUses";
import { presetsWithFiles } from "./presetFiles";
import type { Services } from "./services";
import { readSettings, type Machine, type Settings } from "./settings";

/**
 * Settings › Model files: every model file of ComfyUI's folders on this computer, with what Afflatus knows of each (its
 * hash and what Civitai or Hugging Face match it to, what its header says, its uses by Afflatus's jobs, what was made with
 * it, what needs it), and Delete, Put back, Empty and the drop that adds files. Delete moves (modelBin.ts), Empty alone
 * erases, and neither is ever reached through MCP (mcpTool.ts NEVER["model-files"]). Another machine's files are listed
 * from its last scan, names only, never deleted from here.
 */

/** Something that needs a file: a preset or a model set (Delete asks first), or a family whose slot uses it here. */
export interface Need {
  kind: "preset" | "set" | "family";
  id: string;
  name: string;
}

export interface LibraryFile {
  /** `folder|file` for a file here; `removed:<id>` for one Delete moved, still listed until it is put back or emptied. */
  id: string;
  folder: string;
  /** As ComfyUI lists it: its sub-folder and name, forward slashes. */
  file: string;
  kind: string;
  /** Null for another machine's file: its scan names it only. */
  size: number | null;
  /** The file's date on disk (ms). */
  mtime: number | null;
  /** Null: not hashed yet (its match and its copies are not known). */
  sha256: string | null;
  /** Its name and version where it was found, else its own header's title. */
  name: string | null;
  version: string | null;
  base: string | null;
  picture: string | null;
  link: { site: string; url: string } | null;
  /** What the sites said: Civitai's version, Hugging Face's file, neither, not asked yet. */
  match: "civitai" | "hf" | "none" | "pending";
  uses: number;
  last: string | null;
  /** Some uses were counted by the backfill from today's recipe. */
  approx: boolean;
  /** Uses by month, "2026-10" → n. */
  months: Record<string, number>;
  /** Takes and pictures made with it, in the library. */
  takes: number;
  /** The other files here with the same hash. */
  copies: string[];
  needs: Need[];
  /** The families it is a file of: a slot's file here, or used by its renders. */
  families: string[];
  /** Where it is (this computer only). */
  path: string | null;
  removed: { id: string; place: Place; at: string; batch: string } | null;
}

export interface Library {
  machine: string;
  /** Another machine's files: listed, never deleted from here. */
  readOnly: boolean;
  machines: Array<{ id: string; name: string }>;
  files: LibraryFile[];
  /** The first use Afflatus kept: before it, nothing is known. */
  since: string | null;
  /** What Delete moved and Empty would erase: in the bin, in the set-aside folder. */
  away: { bin: number; aside: number; files: number };
  /** Delete may use the Recycle Bin here (Windows). */
  bin: boolean;
  hashing: { files: number; hashed: number; running: boolean };
  /** No ComfyUI folder on this computer (Settings › ComfyUI): nothing can be listed or deleted. */
  noFolder: boolean;
}

type Lib = Pick<Services, "db" | "registry" | "shippedPresets" | "queue" | "machines" | "comfy" | "hashes">;

const machineName = (m: Machine) => m.name || m.url;
/** The machines whose ComfyUI is this computer's folder: the first one, and any other given the same folder. */
const hereIds = (settings: Settings) => settings.machines.filter((m, i) => !m.rented && (i === 0 || (m.dir && m.dir === settings.comfyDir))).map((m) => m.id);

/** Each file's model folder directories, with whether every one of them could be read. */
async function folderDirs(comfyDir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const folder of HASHED_FOLDERS) out.set(folder, (await modelDirsSaid(comfyDir, folder)).dirs);
  return out;
}

/**
 * A model file of a folder on this computer: its path, refused when the name leads out of the folder, is not a model
 * file's (an extra_model_paths.yaml, a config's .json beside the models), or the file is not there.
 */
async function pathOf(dirs: Map<string, string[]>, folder: string, file: string): Promise<{ path: string; dir: string; size: number } | null> {
  if (!isModelFile(file)) return null;
  for (const dir of dirs.get(folder) ?? []) {
    const path = insideDir(dir, file);
    const st = path ? await stat(path).catch(() => null) : null;
    if (path && st?.isFile()) return { path, dir, size: st.size };
  }
  return null;
}

/** What needs each file, by fileKey: presets and model sets, and the families whose slot uses it on this machine. */
async function needsOf(s: Lib, families: ReadonlyArray<{ id: string; slots: ReadonlyArray<{ folder: string; file: string | null }> }>): Promise<Map<string, Need[]>> {
  const out = new Map<string, Need[]>();
  const add = (f: { folder: string; file: string }, n: Need) => {
    const list = out.get(fileKey(f)) ?? [];
    if (!list.some((x) => x.kind === n.kind && x.id === n.id)) list.push(n);
    out.set(fileKey(f), list);
  };
  for (const p of await presetsWithFiles(s)) for (const f of p.files) add(f, { kind: "preset", id: p.id, name: p.name });
  for (const set of await setsWithFiles(s)) for (const f of set.files) add(f, { kind: "set", id: set.id, name: set.name });
  for (const fam of families) for (const slot of fam.slots) if (slot.file) add({ folder: slot.folder, file: slot.file }, { kind: "family", id: fam.id, name: s.registry.family(fam.id)?.name ?? fam.id });
  return out;
}

/** What Civitai said of each version, by version id. */
async function civitaiOf(s: Pick<Services, "db">) {
  const rows = await s.db.selectFrom("model_civitai").selectAll().execute();
  return new Map(rows.map((r) => [Number(r.version_id), r]));
}

/**
 * What Civitai says of the versions files were matched to, asked once each (a version's page: its model's name, its
 * pictures), at most `most` in a pass, one at a time. Only with lookups on. Returns how many were read.
 */
export async function fillCivitai(s: Pick<Services, "db">, most = 100): Promise<number> {
  const settings = await readSettings(s.db);
  if (!settings.civitaiLookups) return 0;
  const known = await civitaiOf(s);
  const versions = [...new Set((await s.db.selectFrom("model_hashes").select("civitai_version").where("civitai_version", ">", 0).execute()).map((r) => Number(r.civitai_version)))].filter((v) => !known.has(v));
  let n = 0;
  for (const id of versions.slice(0, most)) {
    type Version = { modelId?: number; name?: string; baseModel?: string; model?: { name?: string }; images?: Array<{ url?: string; type?: string; nsfwLevel?: number }> };
    const v = await civitaiGet<Version>(`/api/v1/model-versions/${id}`, settings.civitaiKey).catch(() => undefined);
    // no answer: asked again at the next pass
    if (v === undefined) break;
    // a cover picture only: a video's address shows nothing in an <img>, and an explicit one is not shown in a settings table
    const picture = v?.images?.find((i) => i.url && (i.type ?? "image") === "image" && (i.nsfwLevel ?? 1) <= 1)?.url ?? null;
    const row = { model_id: v?.modelId ?? null, model_name: v?.model?.name ?? null, version_name: v?.name ?? null, base: v?.baseModel ?? null, picture, read_at: now() };
    await s.db.insertInto("model_civitai").values({ version_id: id, ...row }).onConflict((oc) => oc.column("version_id").doUpdateSet(row)).execute();
    n++;
  }
  return n;
}

/** Each generation's takes and pictures still in the library (not in the bin). */
async function takesByGeneration(s: Pick<Services, "db">): Promise<Map<string, number>> {
  const rows = await s.db.selectFrom("assets").select(["generation_id"]).select((eb) => eb.fn.countAll<number>().as("n"))
    .where("generation_id", "is not", null).where("deleted_at", "is", null).groupBy("generation_id").execute();
  return new Map(rows.map((r) => [r.generation_id!, Number(r.n)]));
}

/** The families each generation was made with, for a file's families (a LoRA used with a family is one of its files). */
async function familyOfGenerations(s: Pick<Services, "db">): Promise<Map<string, string>> {
  const rows = await s.db.selectFrom("model_uses").innerJoin("generations", "generations.id", "model_uses.generation_id").select(["generations.id as id", "generations.family as family"]).distinct().execute();
  return new Map(rows.map((r) => [r.id, r.family]));
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** A row of a file Delete moved. */
type Removed = Selectable<Tables["model_removed"]>;

/**
 * Where a file Delete moved stands now: still away; found back in its place (Explorer's Restore); gone from where it was
 * put (the bin emptied, or Windows erasing its oldest items), said only when the folder it was put in is there; or not
 * known (that folder is not there: a drive away for now), which is kept as away.
 */
async function stateOf(r: Removed): Promise<"away" | "back" | "gone" | "unknown"> {
  if (await exists(r.stored_path)) return "away";
  if (await exists(r.path_was)) return "back";
  return (await exists(dirname(r.stored_path))) ? "gone" : "unknown";
}

/**
 * The files Delete moved that are away, as the list shows them: read only, nothing written (a list read on the MCP or a
 * page never changes what is kept). One back in its place or gone from where it was put is left out; settleAway writes so.
 */
async function awayRows(s: Pick<Services, "db">): Promise<Removed[]> {
  const rows = await s.db.selectFrom("model_removed").selectAll().where("restored_at", "is", null).where("emptied_at", "is", null).where("pending", "=", 0).execute();
  const out: Removed[] = [];
  for (const r of rows) {
    const st = await stateOf(r);
    if (st === "away" || st === "unknown") out.push(r);
  }
  return out;
}

/**
 * What was found of the files Delete moved, written: one back in its place taken as put back (Explorer's Restore leaves the
 * bin's entry behind: removed with it), one gone from a folder that is there taken as emptied. A drive away for now
 * changes nothing. Run by the writes of Model files, and by the hourly pass (services.ts).
 */
export async function settleAway(s: Pick<Services, "db">): Promise<void> {
  const rows = await s.db.selectFrom("model_removed").selectAll().where("restored_at", "is", null).where("emptied_at", "is", null).where("pending", "=", 0).execute();
  for (const r of rows) {
    const st = await stateOf(r);
    if (st === "back" && r.info_path) await unlink(r.info_path).catch(() => {});
    if (st === "back" || st === "gone") await s.db.updateTable("model_removed").set(st === "back" ? { restored_at: now() } : { emptied_at: now() }).where("id", "=", r.id).execute();
  }
}

/**
 * The moves cut short (Afflatus stopped between writing where a file was going and its move ending), settled at the start:
 * a file found where it was going and gone from its place is away (its row kept, for Put back); one still in its place
 * did not move (the bin entry made for it removed, the row with it). Neither: its drive is away, asked again next start.
 */
export async function settlePending(s: Pick<Services, "db">): Promise<void> {
  const rows = await s.db.selectFrom("model_removed").selectAll().where("pending", "=", 1).execute();
  for (const r of rows) {
    if ((await exists(r.stored_path)) && !(await exists(r.path_was))) {
      await s.db.updateTable("model_removed").set({ pending: 0 }).where("id", "=", r.id).execute();
    } else if (await exists(r.path_was)) {
      if (r.info_path && !(await exists(r.stored_path))) await unlink(r.info_path).catch(() => {});
      await s.db.deleteFrom("model_removed").where("id", "=", r.id).execute();
    }
  }
}

/** The library of a machine: this computer's folders (`machine` left out or one of hereIds), else another machine's scan. */
export async function library(s: Lib, machine?: string): Promise<Library> {
  const settings = await readSettings(s.db);
  const here = hereIds(settings);
  const own = settings.machines.filter((m) => !m.rented);
  const id = machine && own.some((m) => m.id === machine) ? machine : (here[0] ?? own[0]?.id ?? "");
  const readOnly = !here.includes(id);
  const mc = (await s.machines()).find((x) => x.machine.id === id);
  const scan = await mc?.comfy.scanKept()?.catch(() => null);
  const families = scan?.families ?? [];
  const hashStatus = await s.hashes.status();
  /** A file listed: here (with its path), moved away by Delete (its row), or another machine's (its name only). */
  type Listed = { folder: string; file: string; size: number | null; mtime: number | null; path: string | null; away?: Awaited<ReturnType<typeof awayRows>>[number] };
  const listed: Listed[] = [];
  let noFolder = false;
  if (!readOnly) {
    const dirs = await folderDirs(settings.comfyDir);
    noFolder = [...dirs.values()].every((d) => !d.length);
    for (const [folder, list] of dirs) for (const f of (await filesIn(list, folder)).files) listed.push(f);
    for (const r of await awayRows(s)) listed.push({ folder: r.folder, file: r.file, size: Number(r.size), mtime: null, path: r.path_was, away: r });
  } else if (scan?.comfy.online) {
    // another machine: its scan's lists, by what its recipes offer, and its families' files (names only)
    const seen = new Set<string>();
    const add = (folder: string, raw: string) => {
      const file = raw.replace(/\\/g, "/");
      if (seen.has(`${folder}|${file}`) || !isModelFile(file)) return;
      seen.add(`${folder}|${file}`);
      listed.push({ folder, file, size: null, mtime: null, path: null });
    };
    for (const r of scan.recipes) {
      for (const spec of (s.registry.recipe(r.id)?.inputs ?? []) as InputSpec[]) {
        const folder = spec.type === "model" ? spec.folder : spec.type === "loras" ? "loras" : null;
        if (folder) for (const file of r.options[spec.id] ?? []) add(folder, file);
      }
    }
    for (const fam of families) for (const slot of fam.slots) if (slot.file) add(slot.folder, slot.file);
  }
  const present = new Set(listed.filter((f) => !f.away).map(usedKey));
  const [needs, { usesOf, since }, takes, genFamily, civitai] = await Promise.all([needsOf(s, families), readUses(s.db, readOnly ? [id] : here, present), takesByGeneration(s), familyOfGenerations(s), civitaiOf(s)]);
  const slotFamilies = new Map<string, string[]>();
  for (const fam of families) for (const slot of fam.slots) if (slot.file) slotFamilies.set(fileKey({ folder: slot.folder, file: slot.file }), [...(slotFamilies.get(fileKey({ folder: slot.folder, file: slot.file })) ?? []), fam.id]);
  const infos = new Map((await s.db.selectFrom("model_info").select(["folder", "file", "info"]).execute()).map((r) => [`${r.folder}|${r.file.replace(/\\/g, "/")}`, JSON.parse(r.info) as { title?: string; base?: string }]));
  const pages = new Map((await s.db.selectFrom("model_pages").select(["folder", "name", "url", "title"]).where("url", "!=", "").execute()).map((r) => [`${r.folder}|${r.name}`, r]));
  const hashes = new Map((await s.db.selectFrom("model_hashes").selectAll().execute()).map((r) => [`${r.folder}|${r.file}`, r]));

  /** What is known of one file, by its folder and name (and hash), whatever machine lists it. */
  const describe = (f: Listed): LibraryFile => {
    const k = `${f.folder}|${f.file}`;
    const h = f.away ? (f.away.sha256 ? { sha256: f.away.sha256, civitai_version: null, hf_url: null, matched_at: null, civitai_base: null } : undefined) : hashes.get(k);
    const info = infos.get(k);
    const page = pages.get(`${f.folder}|${nameOf(f.file)}`);
    const key = fileKey(f);
    // a file away is listed with the uses it had: its own, by its name
    const u = f.away ? null : usesOf({ key: usedKey(f), sha256: h?.sha256 ?? null });
    const version = Number(h?.civitai_version) > 0 ? Number(h!.civitai_version) : 0;
    const cv = version ? civitai.get(version) : undefined;
    const match = version ? "civitai" : h?.hf_url ? "hf" : h?.matched_at ? "none" : "pending";
    // Civitai's page is the model's, open on the version: known once the version was read (fillCivitai)
    const link = version && cv?.model_id ? { site: "Civitai", url: `https://civitai.com/models/${Number(cv.model_id)}?modelVersionId=${version}` } : h?.hf_url ? { site: "Hugging Face", url: h.hf_url } : page ? { site: "Page", url: page.url } : null;
    const fams = new Set([...(slotFamilies.get(key) ?? []), ...(u?.generations ?? []).map((g) => genFamily.get(g)).filter((x): x is string => Boolean(x))]);
    // a file Civitai names the base model of (a LoRA, a fine-tune) is of the family that runs that base, used or not
    const civitaiBase = cv?.base || h?.civitai_base;
    if (civitaiBase) for (const [fam, bases] of Object.entries(FAMILY_BASES)) if (bases.includes(civitaiBase)) fams.add(fam);
    return {
      id: f.away ? `removed:${f.away.id}` : k, folder: f.folder, file: f.file, kind: kindOfFolder(f.folder), size: f.size, mtime: f.mtime, sha256: h?.sha256 ?? null,
      name: cv?.model_name ?? (page?.title || null) ?? info?.title ?? null, version: cv?.version_name ?? null, base: cv?.base || h?.civitai_base || info?.base || null, picture: cv?.picture ?? null,
      link, match: f.away ? "none" : match, uses: u?.count ?? 0, last: u?.last ?? null, approx: u?.approx ?? false, months: u?.months ?? {},
      takes: (u?.generations ?? []).reduce((n, g) => n + (takes.get(g) ?? 0), 0), copies: [], needs: needs.get(key) ?? [], families: [...fams], path: f.path,
      removed: f.away ? { id: f.away.id, place: f.away.place, at: f.away.removed_at, batch: f.away.batch } : null,
    };
  };
  const files = listed.map(describe);
  // the same hash twice: the same file, kept twice
  const bySha = new Map<string, LibraryFile[]>();
  for (const f of files) if (f.sha256 && !f.removed) bySha.set(f.sha256, [...(bySha.get(f.sha256) ?? []), f]);
  for (const same of bySha.values()) if (same.length > 1) for (const f of same) f.copies = same.filter((x) => x !== f).map((x) => x.id);
  const away = { bin: 0, aside: 0, files: 0 };
  for (const f of files) if (f.removed) {
    away[f.removed.place] += f.size ?? 0;
    away.files++;
  }
  return {
    machine: id, readOnly, machines: own.map((m) => ({ id: m.id, name: machineName(m) })), files, since, away, bin: process.platform === "win32",
    hashing: { files: hashStatus.files, hashed: hashStatus.hashed, running: hashStatus.hashing !== null }, noFolder,
  };
}

/**
 * The files of the jobs waiting or running: never moved under them (a file a render is loading). By the form's own files
 * and its family's slots here (`names`, fileKey), and by what a running job's graph was noted loading (`used`, usedKey: the
 * helper files a recipe reads that no form names).
 */
async function inUse(s: Lib): Promise<{ names: Set<string>; used: Set<string> }> {
  const jobs = await s.db.selectFrom("jobs").select(["id", "recipe_id", "inputs"]).where("status", "in", ["queued", "running"]).execute();
  const names = new Set<string>();
  const used = new Set<string>();
  if (!jobs.length) return { names, used };
  const scan = await (await s.comfy()).scanKept()?.catch(() => null);
  for (const j of jobs) {
    const recipe = s.registry.recipe(j.recipe_id);
    if (!recipe) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(j.inputs) as Record<string, unknown>;
    } catch {
      // an unreadable form names no file
    }
    for (const f of chosenFiles(recipe.inputs as InputSpec[], input)) names.add(fileKey(f));
    for (const slot of scan?.families.find((x) => x.id === recipe.family)?.slots ?? []) if (slot.file) names.add(fileKey({ folder: slot.folder, file: slot.file }));
  }
  for (let i = 0; i < jobs.length; i += 500) {
    const rows = await s.db.selectFrom("model_uses").select("name_key").where("job_id", "in", jobs.slice(i, i + 500).map((j) => j.id)).execute();
    for (const r of rows) used.add(r.name_key);
  }
  return { names, used };
}

/**
 * A bin finder asked once per drive in one Delete (Windows' answer reads the registry and mountvol), its room taken down by
 * what the Delete put in it already.
 */
function oncePerDrive(bin: BinFinder): { find: BinFinder; took(path: string, bytes: number): void } {
  const spots = new Map<string, ReturnType<BinFinder>>();
  const taken = new Map<string, number>();
  const driveOf = (path: string) => parse(resolve(path)).root.toLowerCase();
  return {
    find: async (path) => {
      const drive = driveOf(path);
      if (!spots.has(drive)) spots.set(drive, bin(path));
      const spot = await spots.get(drive)!;
      return "none" in spot ? spot : { ...spot, room: spot.room - (taken.get(drive) ?? 0) };
    },
    took: (path, bytes) => void taken.set(driveOf(path), (taken.get(driveOf(path)) ?? 0) + bytes),
  };
}

export interface DeleteAsk {
  files: Array<{ folder: string; file: string }>;
  to: Place;
  /** The user saw what needs them and said Delete all: a preset's or a set's file goes too. */
  anyway?: boolean;
}

export interface DeleteDone {
  batch: string;
  moved: number;
  bytes: number;
  /** Files meant for the bin that went to the set-aside folder, and why. */
  aside: Array<{ file: string; why: string }>;
  /** Files left in place, and why (needed, in use, gone, a move that failed). */
  left: Array<{ file: string; why: string }>;
}

/**
 * The Delete of Settings › Model files: each file moved (modelBin.moveOut), never erased; the bin by default. Its row is
 * written before it moves, with where it is going (pending), and completed once moved: a file is never away without a
 * row to put it back by. A row that cannot be written stops the move; one that cannot be completed puts the file back.
 */
export async function deleteFiles(s: Lib, ask: DeleteAsk, bin: BinFinder = systemBin): Promise<DeleteDone> {
  await settleAway(s);
  const settings = await readSettings(s.db);
  const dirs = await folderDirs(settings.comfyDir);
  const allDirs = [...dirs.values()].flat();
  const families = (await (await s.comfy()).scanKept()?.catch(() => null))?.families ?? [];
  const needs = await needsOf(s, families);
  const bins = oncePerDrive(bin);
  // a preset or a set names a file by its name: a copy of it left in another sub-folder still has what it needs
  const asked = new Set(ask.files.map(usedKey));
  const staying = new Set<string>();
  for (const [folder, list] of dirs) for (const f of (await filesIn(list, folder)).files) if (!asked.has(usedKey(f))) staying.add(fileKey(f));
  const batch = randomUUID();
  const done: DeleteDone = { batch, moved: 0, bytes: 0, aside: [], left: [] };
  for (const f of ask.files) {
    const name = baseName(f.file);
    const blocking = staying.has(fileKey(f)) ? [] : (needs.get(fileKey(f)) ?? []).filter((n) => n.kind !== "family");
    if (blocking.length && !ask.anyway) {
      done.left.push({ file: name, why: `${blocking[0]!.kind === "preset" ? "the preset" : "the model set"} ${blocking[0]!.name} needs it` });
      continue;
    }
    const at = await pathOf(dirs, f.folder, f.file);
    if (!at) {
      done.left.push({ file: name, why: isModelFile(f.file) ? "it is not in ComfyUI's folders any more" : "it is not a model file" });
      continue;
    }
    // asked again for each file, just before it moves: a job sent meanwhile counts
    const busy = await inUse(s);
    if (busy.names.has(fileKey(f)) || busy.used.has(usedKey(f))) {
      done.left.push({ file: name, why: "a job waiting or running uses it" });
      continue;
    }
    const sha = (await s.db.selectFrom("model_hashes").select("sha256").where("folder", "=", f.folder).where("file", "=", f.file.replace(/\\/g, "/")).executeTakeFirst())?.sha256 ?? null;
    const id = randomUUID();
    let written = false;
    try {
      const m = await moveOut(at.path, {
        want: ask.to, size: at.size, folder: f.folder, file: f.file, aside: asideRoot(at.dir, allDirs), bin: bins.find,
        // where it is going, kept before it goes (again with another name when the first was taken)
        planned: async (p) => {
          const row = { place: p.place, stored_path: p.stored, info_path: p.info };
          if (written) await s.db.updateTable("model_removed").set(row).where("id", "=", id).execute();
          else await s.db.insertInto("model_removed").values({
            id, batch, folder: f.folder, file: f.file.replace(/\\/g, "/"), path_was: at.path, size: at.size, sha256: sha, ...row,
            removed_at: now(), restored_at: null, emptied_at: null, pending: 1,
          }).execute();
          written = true;
        },
      });
      try {
        await s.db.updateTable("model_removed").set({ pending: 0 }).where("id", "=", id).execute();
      } catch (err) {
        // moved, but its row could not say so: back in its place, rather than away with nothing to put it back by
        await moveBack({ stored: m.stored, info: m.info, was: at.path });
        await s.db.deleteFrom("model_removed").where("id", "=", id).execute().catch(() => {});
        throw err;
      }
      if (m.place === "bin") bins.took(at.path, at.size);
      done.moved++;
      done.bytes += at.size;
      if (m.why !== null) done.aside.push({ file: name, why: m.why });
    } catch (err) {
      // not moved (the move refused, or its row not written): no row left behind for it
      if (written && (await exists(at.path))) await s.db.deleteFrom("model_removed").where("id", "=", id).where("pending", "=", 1).execute().catch(() => {});
      done.left.push({ file: name, why: (err as Error).message });
    }
  }
  if (done.moved) await changed(s);
  return done;
}

/** ComfyUI's lists and Afflatus's own of them read again: a file came or went. */
async function changed(s: Lib): Promise<void> {
  for (const { comfy } of await s.machines()) comfy.forgetFiles();
  s.queue.events.emit("models");
  s.queue.events.emit("setup");
  void s.hashes.run();
}

/** Put back: the moved files (by their ids, or one Delete's batch) returned where they were. */
export async function putBack(s: Lib, which: { ids?: string[]; batch?: string }): Promise<{ back: number; left: Array<{ file: string; why: string }> }> {
  await settleAway(s);
  let q = s.db.selectFrom("model_removed").selectAll().where("restored_at", "is", null).where("emptied_at", "is", null).where("pending", "=", 0);
  if (which.batch) q = q.where("batch", "=", which.batch);
  else if (which.ids?.length) q = q.where("id", "in", which.ids);
  else throw httpError("Say which files to put back.", 400);
  const out = { back: 0, left: [] as Array<{ file: string; why: string }> };
  for (const r of await q.execute()) {
    try {
      await moveBack({ stored: r.stored_path, info: r.info_path, was: r.path_was });
      await s.db.updateTable("model_removed").set({ restored_at: now() }).where("id", "=", r.id).execute();
      // hashed again in moments: the same bytes, its hash kept (asked again of the sites, once)
      if (r.sha256) {
        const st = await stat(r.path_was).catch(() => null);
        if (st) await s.db.insertInto("model_hashes").values({ folder: r.folder, file: r.file, size: st.size, mtime: Math.round(st.mtimeMs), sha256: r.sha256, hashed_at: now(), civitai_version: null, hf_url: null, matched_at: null })
          .onConflict((oc) => oc.columns(["folder", "file"]).doNothing()).execute();
      }
      out.back++;
    } catch (err) {
      out.left.push({ file: baseName(r.file), why: (err as Error).message });
    }
  }
  if (out.back) await changed(s);
  return out;
}

/**
 * Empty: what Delete moved, erased for good (the bin's entries and the set-aside folder's files). The only erase there is.
 * A file whose drive is away now is left for a later Empty.
 */
export async function emptyAway(s: Pick<Services, "db">): Promise<{ erased: number; bytes: number }> {
  await settleAway(s);
  let erased = 0;
  let bytes = 0;
  for (const r of await awayRows(s)) {
    if (!(await exists(r.stored_path))) continue;
    await erase({ stored: r.stored_path, info: r.info_path });
    await s.db.updateTable("model_removed").set({ emptied_at: now() }).where("id", "=", r.id).execute();
    erased++;
    bytes += Number(r.size);
  }
  return { erased, bytes };
}

/**
 * The model folder a dropped file goes to, from its .safetensors header (sent by the page: its first bytes): a LoRA by
 * its low-rank factors, a whole checkpoint by its three parts, a diffusion model by its weights, a VAE, a text encoder, an
 * upscaler, a CLIP vision or a ControlNet by their layers' names. Null when the header does not tell (the page asks).
 */
export function folderOfHeader(header: Record<string, unknown> | null): string | null {
  if (!header) return null;
  const names = [...tensorsOf(header).keys()];
  if (!names.length) return null;
  const any = (re: RegExp) => names.some((n) => re.test(n));
  if (any(/lora_(down|up|A|B)\b|\.lora\.|lokr_|hada_/)) return "loras";
  if (any(/^model\.diffusion_model\./) && any(/^first_stage_model\.|^vae\./)) return "checkpoints";
  if (any(/^(control_model|controlnet_)/)) return "controlnet";
  if (any(/^vision_model\.|^visual\./) && !any(/^text_model\./)) return "clip_vision";
  if (architectureOf(tensorsOf(header))) return "diffusion_models";
  if (any(/^(encoder|decoder)\.(down|up|mid|conv_in)/) || any(/^(encoder|decoder)\.(block|blocks)\.\d+\.(resnets|conv)/)) return "vae";
  if (any(/^(encoder\.block|shared\.weight|text_model\.|model\.layers\.|transformer\.h\.|language_model\.)/)) return "text_encoders";
  if (any(/^(conv_first|model\.0\.weight|body\.\d+|RRDB_trunk)/)) return "upscale_models";
  return null;
}

/**
 * Why a dropped file's name is refused, or null: one Windows cannot hold, or holds as something else (a colon names an
 * alternate stream of another file; CON, NUL, COM1… are devices; a trailing dot or space is dropped, so the file would not
 * be found under its name), or one that does not end as a model file's.
 */
export function badName(name: string): string | null {
  if (!name || name.startsWith(".")) return "a name is needed, not starting with a dot";
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return "it holds a character Windows does not take in a file name (< > : \" | ? *)";
  if (/[. ]$/.test(name)) return "it ends with a dot or a space";
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name)) return "it is a name Windows keeps for a device (CON, NUL, COM1…)";
  if (!isModelFile(name)) return "it is not a model file (.safetensors, .gguf, .ckpt, .pt, .pth, .bin, .onnx)";
  return null;
}

/**
 * A dropped file written into its folder on this computer (the folder's first directory), as it arrives: under a `.part`
 * name of this request's own until its last byte, then put in place without ever replacing a file (one arriving under the
 * same name meanwhile is kept, this one refused). Only this request's `.part` is ever removed.
 */
export async function addFile(s: Lib, folder: string, name: string, body: Readable): Promise<{ file: string; bytes: number }> {
  if (!HASHED_FOLDERS.includes(folder)) throw httpError("there is no such model folder", 400);
  const clean = baseName(name.trim());
  const bad = badName(clean);
  if (bad) throw httpError(`${clean || "That file"} is refused: ${bad}.`, 400);
  const dir = (await modelDirsSaid((await readSettings(s.db)).comfyDir, folder)).dirs[0];
  if (!dir) throw httpError("ComfyUI's folder on this computer is not known (Settings › ComfyUI › Folder on this computer).", 409);
  const path = insideDir(dir, clean);
  if (!path) throw httpError("That name leads out of the folder.", 400);
  const already = () => httpError(`${clean} is in ${folder} already.`, 409);
  if (await exists(path)) throw already();
  const part = join(dir, `${clean}.${randomUUID().slice(0, 8)}.part`);
  let bytes = 0;
  let mine = false;
  body.on("data", (b: Buffer) => (bytes += b.length));
  try {
    // made only where none is: the .part is this request's from its first byte
    const out = createWriteStream(part, { flags: "wx" });
    out.on("open", () => (mine = true));
    await pipeline(body, out);
    await moveNoClobber(part, path).catch((err: Error) => {
      throw err instanceof Taken ? already() : err;
    });
    mine = false;
  } finally {
    if (mine) await unlink(part).catch(() => {});
  }
  await changed(s);
  return { file: clean, bytes };
}
