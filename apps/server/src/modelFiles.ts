import { open, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNetworkPath } from "./linked";

/**
 * ComfyUI's model files on this computer, when Afflatus knows ComfyUI's folder: where a model folder's
 * files really are, and a .safetensors file's whole header (its metadata and the names and shapes of its
 * tensors, which say which model it is for). ComfyUI's own endpoint gives the metadata alone. Nothing
 * past the header is read: a few hundred kilobytes of a file of many gigabytes.
 */

/** ComfyUI's older names for some folders, which extra_model_paths.yaml may still use (A1111's layout among them): folder_paths.map_legacy. */
const LEGACY: Record<string, string[]> = { diffusion_models: ["unet"], text_encoders: ["clip"] };

/**
 * The directories under `models/` ComfyUI reads a folder from, in its own order (folder_paths.py): models/unet before
 * models/diffusion_models, so a name held in both is unet's file. Read the other way round, the file ComfyUI loads was the
 * one marked shadowed (no "needed by", a Delete with no warning) and the name's hash, a pod's source, the other file's.
 */
const OWN: Record<string, string[]> = { diffusion_models: ["unet", "diffusion_models"], text_encoders: ["text_encoders", "clip"], controlnet: ["controlnet", "t2i_adapter"] };

/** The biggest header read: a safetensors header is small, and a file that claims more is not one. */
const HEADER_MOST = 64 * 1024 * 1024;

/**
 * The directories ComfyUI reads a model folder from, in the order it looks for a name in them: `<comfyDir>/models/<folder>`
 * (and its older name, OWN's order), then what `extra_model_paths.yaml` adds, a section with `is_default` put first as
 * ComfyUI puts it (add_model_folder_path). Empty when ComfyUI's folder is not known or not here. A folder on a network
 * share is never looked at (see isNetworkPath): a stat of it reaches for the share, the files come through ComfyUI.
 * Where Afflatus writes a new file is not this order's first: placesOf (modelDownload.ts) puts `models/<folder>` first.
 */
export async function modelDirs(comfyDir: string, folder: string): Promise<string[]> {
  return (await modelDirsSaid(comfyDir, folder)).dirs;
}

/**
 * modelDirs, and whether every directory extra_model_paths.yaml names for the folder is there: one that is not may be a
 * drive unplugged for now, whose files are not gone (modelHashes.ts forgets nothing of such a folder). ComfyUI's own
 * folders under its directory may be missing for good (the older names), and say nothing.
 */
export async function modelDirsSaid(comfyDir: string, folder: string): Promise<{ dirs: string[]; all: boolean }> {
  const base = comfyDir.trim();
  if (!base || isNetworkPath(base) || !(await isDir(base))) return { dirs: [], all: false };
  const dirs = (OWN[folder] ?? [folder]).map((f) => ({ path: join(base, "models", f), extra: false }));
  let extra: ExtraDir[] = [];
  try {
    extra = extraPaths(await readFile(join(base, "extra_model_paths.yaml"), "utf8"), base, folder);
  } catch {
    // no extra paths file: the default folders are all there is
  }
  // as ComfyUI adds them: a path listed already is not added twice, and a default one goes first (moved there when listed)
  for (const e of extra) {
    const at = dirs.findIndex((d) => d.path === e.path);
    if (at >= 0 && !e.isDefault) continue;
    if (at >= 0) dirs.splice(at, 1);
    // a directory the file names may be a drive unplugged for now: `all` says so when it is not there
    if (e.isDefault) dirs.unshift({ path: e.path, extra: true });
    else dirs.push({ path: e.path, extra: true });
  }
  const out: string[] = [];
  let all = true;
  for (const d of dirs) {
    if (out.includes(d.path) || isNetworkPath(d.path)) continue;
    if (await isDir(d.path)) out.push(d.path);
    else if (d.extra) all = false;
  }
  return { dirs: out, all };
}

/** A directory extra_model_paths.yaml names for a folder, and whether its section is `is_default` (ComfyUI reads it first). */
export interface ExtraDir {
  path: string;
  isDefault: boolean;
}

/**
 * The directories a ComfyUI extra_model_paths.yaml names for a folder: each top section has a
 * `base_path` and, per folder, one path or a `|` block of several, relative to that base. Read with a
 * small reader of its own: the file is simple and a YAML library is not worth carrying for it. The paths alone, for the
 * tests: Afflatus reads extraPaths, with is_default. @internal
 */
export function extraDirs(yaml: string, comfyDir: string, folder: string): string[] {
  return extraPaths(yaml, comfyDir, folder).map((d) => d.path);
}

/**
 * extraDirs, with each section's `is_default` (read for the whole section, wherever the key is in it, as ComfyUI pops it
 * before the folders). Its base path too applies to the whole section, as ComfyUI pops it first.
 */
export function extraPaths(yaml: string, comfyDir: string, folder: string): ExtraDir[] {
  const names = [folder, ...(LEGACY[folder] ?? [])];
  const out: ExtraDir[] = [];
  /** The section being read: its paths, as written, resolved once its base path and is_default are known. */
  let section = { basePath: "", isDefault: false, paths: [] as string[] };
  const flush = () => {
    for (const p of section.paths) out.push({ path: resolveUnder(section.basePath, comfyDir, p), isDefault: section.isDefault });
    section = { basePath: "", isDefault: false, paths: [] };
  };
  let block: boolean = false;
  /** A `key: value` line of a section: its base path, its is_default, or a folder's path (or the start of a | block). */
  const keyLine = (key: string, value: string) => {
    const v = value.trim();
    if (key === "base_path") section.basePath = v;
    else if (key === "is_default") section.isDefault = !/^(false|no|off|0|null|~)?$/i.test(v.replace(/^["']|["']$/g, ""));
    else if (names.includes(key)) {
      if (v === "|" || v === "") block = true;
      else section.paths.push(v);
    }
  };
  const lines = yaml.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0 && /^[\w-]+:\s*$/.test(text)) {
      // a new section (comfyui:, a1111:, …)
      flush();
      block = false;
      continue;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(text);
    if (m && !block) {
      keyLine(m[1]!, m[2]!);
      continue;
    }
    if (block) {
      // the lines of a | block: paths, until a line that is a key again
      if (m && indent <= 5) {
        block = false;
        keyLine(m[1]!, m[2]!);
        continue;
      }
      section.paths.push(text);
    }
  }
  flush();
  return out;
}

const resolveUnder = (basePath: string, comfyDir: string, p: string) => (isAbsolute(p) ? p : resolve(basePath ? (isAbsolute(basePath) ? basePath : join(comfyDir, basePath)) : comfyDir, p));

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a file named as ComfyUI names a model (its path inside the folder, with either slash) is under a directory, or
 * null when the name would lead out of it: "..", an absolute path, a drive. The name comes from ComfyUI's answer, and a
 * ComfyUI that names "../../somewhere/file.safetensors" does not get Afflatus to read, nor to hash for Civitai, a file
 * outside its models folder. The check is on the path as written: a link the user put inside a models folder (a model
 * kept on another drive) is followed, as ComfyUI follows it.
 */
export function insideDir(dir: string, file: string): string | null {
  const rel = file.replace(/\\/g, "/");
  if (!rel || rel.includes("\0") || rel.startsWith("/") || /^[a-z]:/i.test(rel) || rel.split("/").some((part) => part === "..")) return null;
  const root = resolve(dir);
  const path = resolve(root, rel);
  const back = relative(root, path);
  return back && back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back) ? path : null;
}

/**
 * The header of a .safetensors file found under one of the directories, as ComfyUI names the file
 * (its path inside the folder, with either slash). Null when the file is not there, or is not one,
 * or is named outside the directories (insideDir).
 */
export async function readLocalHeader(dirs: string[], file: string): Promise<Record<string, unknown> | null> {
  if (!/\.safetensors$/i.test(file)) return null;
  for (const dir of dirs) {
    const path = insideDir(dir, file);
    if (!path) return null;
    let fh;
    try {
      fh = await open(path, "r");
    } catch {
      continue;
    }
    try {
      const head = Buffer.alloc(8);
      const { bytesRead } = await fh.read(head, 0, 8, 0);
      if (bytesRead < 8) return null;
      const size = Number(head.readBigUInt64LE(0));
      if (!Number.isFinite(size) || size <= 0 || size > HEADER_MOST) return null;
      const body = Buffer.alloc(size);
      const got = await fh.read(body, 0, size, 8);
      if (got.bytesRead < size) return null;
      return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      await fh.close();
    }
  }
  return null;
}
