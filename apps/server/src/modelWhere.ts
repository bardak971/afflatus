import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ComfyClient } from "@afflatus/comfy";
import { isModelFile } from "@afflatus/core";
import { httpError, notFound } from "./errors";
import { downloadTarget } from "./fetchFile";
import { fromThisComputer } from "./hostCheck";
import { isNetworkPath } from "./linked";
import { comfyBase, comfyFolderPaths, inside, listedFor, NOT_MODELS, onThisMachine, placesOf } from "./modelDownload";
import { modelDirs } from "./modelFiles";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Where a model file is on disk (card #64): each of ComfyUI's folders for it that holds it, and opening the file manager
 * on one. ComfyUI's lists name a file by its folder and its name under that folder only: its whole path is found by
 * looking for it in each directory ComfyUI reads the folder from, which only works on the machine ComfyUI runs on.
 */

/** One place a model file is, as the page is told it. */
export interface FilePlace {
  /** The whole path on disk. */
  path: string;
  /** Under which of ComfyUI's directories for the folder: its own `models/<folder>`, the folder's older name, or another. */
  kind: "own" | "older" | "other";
}

/** What the page is told of a file's places. */
export interface FileWhere {
  /** Whether its places can be known here: ComfyUI runs on the machine Afflatus runs on. */
  known: boolean;
  /** Each place it is, ComfyUI's own models/<folder> first: one place more is a copy worth seeing. Empty when not known. */
  places: FilePlace[];
  /** Whether Show in folder is offered: known, and asked from this computer itself, whose screen the file manager opens on. */
  reveal: boolean;
}

/**
 * A file's name under its folder, as its parts: never empty, never one going up a folder, and a model file's name. Null
 * for any other: with ComfyUI not saying its folders, the folder set in Settings is looked in, and any device signed in
 * could otherwise ask whether ComfyUI's own files are there (extra_model_paths.yaml) and be told their paths.
 */
function nameParts(file: string): string[] | null {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length && !parts.some((p) => p === "." || p === "..") && !/[:*?"<>|\x00-\x1f]/.test(file) && isModelFile(parts.at(-1)!) ? parts : null;
}

/**
 * A model folder's name as ComfyUI keys it ("loras", "ultralytics_bbox", "frame_interpolation"): no dot, no slash. "." or
 * ".." passed the earlier `[\w.-]` and, from a ComfyUI not saying its folders, was looked for in models/.. (ComfyUI's own).
 */
const FOLDER = /^[\w-]+$/;

/** ComfyUI's folder list, kept a few seconds per ComfyUI: a list of 80 files asks for each file's places at once. */
const listed = new Map<string, { at: number; paths: Promise<Record<string, string[]> | null> }>();
const KEPT_MS = 10_000;

function folderPathsOf(client: Pick<ComfyClient, "raw" | "baseUrl">): Promise<Record<string, string[]> | null> {
  const was = listed.get(client.baseUrl);
  if (was && Date.now() - was.at < KEPT_MS) return was.paths;
  const paths = comfyFolderPaths(client);
  listed.set(client.baseUrl, { at: Date.now(), paths });
  return paths;
}

/**
 * Every place a model file is on this machine: each directory ComfyUI reads its folder from (from /internal/folder_paths,
 * extra_model_paths.yaml counted; from an older ComfyUI, the folder set in Settings), in placesOf's order, that holds a
 * file of that name. Only a path under one of those directories is ever said, never one on a network share (a stat of it
 * reaches for the share). Null when ComfyUI runs on another machine: its paths are its own disk's, nothing here to look at.
 */
export async function filePlaces(client: Pick<ComfyClient, "raw" | "baseUrl">, comfyDir: string, folder: string, file: string): Promise<FilePlace[] | null> {
  if (!onThisMachine(client.baseUrl)) return null;
  const parts = nameParts(file);
  if (!parts || NOT_MODELS.has(folder) || !FOLDER.test(folder)) return [];
  const paths = await folderPathsOf(client);
  const dirs = paths ? listedFor(paths, folder) : await modelDirs(comfyDir, folder);
  const out: FilePlace[] = [];
  for (const place of placesOf(dirs, folder, comfyBase(paths, comfyDir))) {
    const dir = place.path;
    if (!isAbsolute(dir) || isNetworkPath(dir)) continue;
    const path = join(dir, ...parts);
    if (!inside(dir, path)) continue;
    if ((await stat(path).catch(() => null))?.isFile()) out.push({ path, kind: place.kind });
  }
  return out;
}

/**
 * The file manager opened on a file, with the file selected where the system can: Explorer's /select, Finder's reveal;
 * on Linux its folder (xdg-open has no select). Started without a shell, the path one argument: nothing in it is read as
 * a command. Kept as an object so tests can stand in for it: none of them opens a window.
 */
export const fileManager = {
  show(path: string): void {
    const [cmd, args, verbatim] =
      process.platform === "win32"
        ? // Explorer reads `/select,"<path>"` as one argument, its quotes its own: a Windows path never holds a quote
          (["explorer.exe", [`/select,"${path}"`], true] as const)
        : process.platform === "darwin"
          ? (["open", ["-R", path], false] as const)
          : (["xdg-open", [dirname(path)], false] as const);
    const child = spawn(cmd, [...args], { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
    // Explorer ends with 1 when it did open the folder; a missing xdg-open has nothing to say to the page either
    child.on("error", () => {});
    child.unref();
  },
};

/**
 * A model file, by its folder and its name under it (core fileKey's parts), on one ComfyUI (left out: the first). A folder
 * that is no folder's name, or a name that is no model file's, is refused outright: filePlaces would find nothing anyway.
 */
const fileOf = z.object({
  folder: z.string().min(1).max(120).regex(FOLDER, "that is not a models folder"),
  file: z.string().min(1).max(500).refine((f) => nameParts(f) !== null, "that is not a model file's name"),
  machine: z.string().max(40).optional(),
});

export function registerModelWhere(app: FastifyInstance, s: Services): void {
  const whereOf = async (q: z.infer<typeof fileOf>) => {
    const settings = await readSettings(s.db);
    if (!settings.machines.length) return null;
    const { comfy, dir } = await downloadTarget(s, settings, q.machine);
    return filePlaces(comfy.client, dir, q.folder, q.file);
  };

  /** Where a model file is on disk: every place it is, and whether Show in folder can open one (card #64). */
  app.get("/api/model-files/where", async (req): Promise<FileWhere> => {
    const places = await whereOf(fileOf.strict().parse(req.query));
    return { known: places !== null, places: places ?? [], reveal: places !== null && fromThisComputer(req) };
  });

  /**
   * Show in folder: the file manager of this computer opened on one of a model file's places. The page never sends a path:
   * it names the file (its folder and name) and which of its places (`at`, in the order /where lists them), and the file
   * is looked for again here. Only from this computer itself: a request from another one would open a window on a screen
   * nobody there looks at.
   */
  app.post("/api/model-files/reveal", async (req) => {
    const q = fileOf.extend({ at: z.number().int().min(0).max(50).default(0) }).strict().parse(req.body);
    if (!fromThisComputer(req)) throw httpError("Show in folder opens on the computer Afflatus runs on: from another one, copy the path.", 403);
    const places = await whereOf(q);
    if (places === null) throw httpError("ComfyUI runs on another machine: its files are not on this one's disk.", 409);
    const place = places[q.at];
    if (!place) throw notFound("that file in ComfyUI's model folders");
    fileManager.show(place.path);
    return { ok: true };
  });
}
