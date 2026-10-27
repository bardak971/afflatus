import { open, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNetworkPath } from "./linked";

/**
 * ComfyUI's model files on this computer, when Afflatus knows ComfyUI's folder: where a model folder's
 * files really are, and a .safetensors file's whole header (its metadata and the names and shapes of its
 * tensors, which say which model it is for). ComfyUI's own endpoint gives the metadata alone. Nothing
 * past the header is read: a few hundred kilobytes of a file of many gigabytes.
 */

/** ComfyUI's older names for some folders, still read beside the new ones, and named in extra_model_paths.yaml (A1111's layout among them). */
const LEGACY: Record<string, string[]> = { diffusion_models: ["unet"], text_encoders: ["clip"] };

/** The biggest header read: a safetensors header is small, and a file that claims more is not one. */
const HEADER_MOST = 64 * 1024 * 1024;

/**
 * The directories ComfyUI reads a model folder from: `<comfyDir>/models/<folder>` (and its older
 * name), then what `extra_model_paths.yaml` adds. Empty when ComfyUI's folder is not known or not here. A folder on a
 * network share is never looked at (see isNetworkPath): a stat of it reaches for the share, the files come through ComfyUI.
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
  const dirs = [join(base, "models", folder), ...(LEGACY[folder] ?? []).map((f) => join(base, "models", f))];
  const own = dirs.length;
  try {
    dirs.push(...extraDirs(await readFile(join(base, "extra_model_paths.yaml"), "utf8"), base, folder));
  } catch {
    // no extra paths file: the default folders are all there is
  }
  const out: string[] = [];
  let all = true;
  for (const [i, d] of dirs.entries()) {
    if (out.includes(d) || isNetworkPath(d)) continue;
    if (await isDir(d)) out.push(d);
    else if (i >= own) all = false;
  }
  return { dirs: out, all };
}

/**
 * The directories a ComfyUI extra_model_paths.yaml names for a folder: each top section has a
 * `base_path` and, per folder, one path or a `|` block of several, relative to that base. Read with a
 * small reader of its own: the file is simple and a YAML library is not worth carrying for it.
 */
export function extraDirs(yaml: string, comfyDir: string, folder: string): string[] {
  const names = [folder, ...(LEGACY[folder] ?? [])];
  const out: string[] = [];
  let basePath = "";
  let block: boolean = false;
  const lines = yaml.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0 && /^[\w-]+:\s*$/.test(text)) {
      // a new section (comfyui:, a1111:, …): its base path comes next
      basePath = "";
      block = false;
      continue;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(text);
    if (m && !block) {
      const [, key, value] = m;
      if (key === "base_path") {
        basePath = value!.trim();
        continue;
      }
      if (names.includes(key!)) {
        if (value!.trim() === "|" || value!.trim() === "") {
          block = true;
          continue;
        }
        out.push(resolveUnder(basePath, comfyDir, value!.trim()));
      }
      continue;
    }
    if (block) {
      // the lines of a | block: paths, until a line that is a key again
      if (/^[\w-]+:/.test(text) && indent <= 5) {
        block = false;
        const mm = /^([\w-]+):\s*(.*)$/.exec(text)!;
        if (mm[1] === "base_path") basePath = mm[2]!.trim();
        else if (names.includes(mm[1]!) && mm[2]!.trim() && mm[2]!.trim() !== "|") out.push(resolveUnder(basePath, comfyDir, mm[2]!.trim()));
        else if (names.includes(mm[1]!)) block = true;
        continue;
      }
      out.push(resolveUnder(basePath, comfyDir, text));
    }
  }
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
