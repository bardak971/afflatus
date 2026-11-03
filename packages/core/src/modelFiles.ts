/**
 * Model files as ComfyUI's loaders list them. One list of extensions, so every place that asks "is this a model
 * file" or "what is it called without its extension" gives the same answer: written by hand in twelve places, the
 * list had four variants, and two of them missed .bin and .onnx.
 */
export const MODEL_EXTS = ["safetensors", "sft", "ckpt", "pt", "pth", "bin", "gguf", "onnx"] as const;

/** A pattern for names ending in one of these extensions (and in nothing after them), whatever the case. */
export const endsIn = (exts: readonly string[]) => new RegExp(`\\.(${exts.join("|")})$`, "i");

/** A model file's extension, at the end of a name: "x.safetensors", "Wan\\x.GGUF". */
export const MODEL_EXT = endsIn(MODEL_EXTS);

/** Whether a name is a model file's. */
export const isModelFile = (name: string) => MODEL_EXT.test(name);

/**
 * The most files one /api/model-files/where names (card #74): a page's list (Find models › Yours shows up to 80), never a
 * whole disk. The page sends a longer list in parts of this size.
 */
export const WHERE_MOST = 200;

/**
 * ComfyUI's usual model folders, in the order they are offered: where a file with no folder of its own can go while
 * ComfyUI does not say its own, and the folders hashed, searched and listed on a pod (those less embeddings). Written by
 * hand five times, server and web, the lists could drift apart as a folder was added to some of them only.
 */
export const USUAL_FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders", "embeddings"] as const;

/** The usual folders whose files are full models (embeddings left out): the ones hashed, searched and read on a pod. */
export const FULL_MODEL_FOLDERS: readonly string[] = USUAL_FOLDERS.filter((f) => f !== "embeddings");

/**
 * A model file's name without its sub-folder, split on either slash: ComfyUI on Windows lists "SDXL\\x.safetensors". The
 * tests below that ask for the bare name all split here, so none can drop the backslash again: the official test did once,
 * and a pod was sent a file its fetch then refused, billed while it waited (2026-10-22).
 */
export const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/**
 * One model file wherever it is said, by its folder and its name without its sub-folder, lower case: a job's file, a
 * preset's, a set's and a pod's are the same file when this is the same (a pod lists a file by its name in the folder).
 */
export const fileKey = (f: { folder: string; file: string }) => `${f.folder}|${nameKey(f.file)}`;

/** A model file's name without its folder and without its extension: "Wan\\wan_2.1_vae.safetensors" → "wan_2.1_vae". */
export const modelStem = (file: string) => baseName(file).replace(MODEL_EXT, "");

/** The families' downloads (their slots' `get`), as the server and the web both have them. */
type Downloads = ReadonlyArray<{ slots?: ReadonlyArray<{ get?: { file: string; url: string; sha256?: string } }> }>;

/**
 * A file's name as a key, lower case without its sub-folder: the same file on Windows and on a pod. Written by hand about
 * eleven times, server and web.
 */
export const nameKey = (file: string) => baseName(file).toLowerCase();

/** Whether `file` is a family's official file by its name (a slot's download), whatever its sub-folder or case. */
export const isOfficialName = (families: Downloads, file: string): boolean =>
  families.some((f) => (f.slots ?? []).some((x) => x.get !== undefined && nameKey(x.get.file) === nameKey(file)));

/**
 * Whether `url` is a family's own official file for `file` (a slot's `get`): the same address, and a file of the same name
 * whatever its sub-folder or case. Fetching it is no lookup, the address is the family's own, so the server fetches it
 * whatever the downloads and lookups settings say (a Download pressed on it, or a pod getting it for a deploy or a queued
 * job), and the web offers its Download on the same terms. The folder is not asked: it says where the file lands, not
 * what is fetched, and a shipped preset loads a family's checkpoint as a diffusion model (LTX 2.3 distilled). The planner
 * gave that file its official address and sent it to a pod, whose fetch then refused it as no official file of that
 * folder, the pod billed while it waited (2026-10-22). The web and the server each had a test of their own, apart.
 */
export const isOfficialFile = (families: Downloads, want: { url?: string; file: string }): boolean => officialGet(families, want) !== undefined;

/** The family's download `want` is (isOfficialFile), with the bytes it must have when they are known. */
export const officialGet = (families: Downloads, want: { url?: string; file: string }): { file: string; url: string; sha256?: string } | undefined => {
  if (!want.url) return undefined;
  for (const f of families) for (const x of f.slots ?? []) if (x.get !== undefined && x.get.url === want.url && nameKey(x.get.file) === nameKey(want.file)) return x.get;
  return undefined;
};

/** What each model folder holds, as Settings › Model files names its kind; a folder not named here is "Other". */
const KINDS: Record<string, string> = {
  checkpoints: "Checkpoint", diffusion_models: "Diffusion model", loras: "LoRA", vae: "VAE", text_encoders: "Text encoder",
  clip_vision: "CLIP vision", upscale_models: "Upscaler", latent_upscale_models: "Upscaler", controlnet: "ControlNet", audio_encoders: "Audio encoder",
};

/** A model folder's kind of file ("loras" is "LoRA"). */
export const kindOfFolder = (folder: string) => KINDS[canonicalFolder(folder)] ?? "Other";

/** A file's path as a key: forward slashes, lower case ("SDXL\\X.safetensors" is "sdxl/x.safetensors"). */
export const pathKey = (file: string) => file.replace(/\\/g, "/").toLowerCase();

/**
 * A safetensors file by its name: ".sft" is the same format (Flux's files were shipped so). The downloader counted .sft as
 * safetensors, while the header read, the update check and the drop in Settings › Model files took .safetensors alone.
 */
export const SAFETENSORS = endsIn(["safetensors", "sft"]);
export const isSafetensors = (name: string) => SAFETENSORS.test(name);
/** The biggest safetensors header read, server and page: a header is small, and a file that claims more is not one. */
export const SAFETENSORS_HEADER_MOST = 64 * 2 ** 20;

/**
 * ComfyUI's older names of two model folders, which it still reads (folder_paths.map_legacy): a file in models/unet is a
 * diffusion model, one in models/clip a text encoder.
 */
export const LEGACY_FOLDER: Readonly<Record<string, string>> = { unet: "diffusion_models", clip: "text_encoders" };

/** A model folder by its current name: "unet" is "diffusion_models", "clip" is "text_encoders"; any other as it is. */
export const canonicalFolder = (folder: string) => LEGACY_FOLDER[folder] ?? folder;

/** A model folder's other name, older or newer ("unet" ↔ "diffusion_models"); undefined for a folder with one name. */
export const otherName = (folder: string): string | undefined =>
  LEGACY_FOLDER[folder] ?? Object.keys(LEGACY_FOLDER).find((old) => LEGACY_FOLDER[old] === folder);

/** Civitai's types of model, as its API takes them (`types=`). */
export const CIVITAI_TYPES = ["Checkpoint", "UNet", "LORA", "LoCon", "DoRA", "VAE", "TextEncoder", "CLIP", "CLIPVision", "Upscaler", "Controlnet", "TextualInversion", "Detection", "Other"] as const;
export type CivitaiType = (typeof CIVITAI_TYPES)[number];

/**
 * What Civitai calls the models of each ComfyUI folder, the folder's usual kind first. One table both ways: the search for
 * a file of a folder asks for these types, and a Civitai link's type says its folder. The two were written apart and had
 * drifted: a link to a detector got no folder, and UNet, CLIP and CLIP vision models were never asked for.
 */
const CIVITAI_KINDS: Readonly<Record<string, readonly CivitaiType[]>> = {
  checkpoints: ["Checkpoint"], diffusion_models: ["UNet", "Checkpoint"],
  loras: ["LORA", "LoCon", "DoRA"], vae: ["VAE"], text_encoders: ["TextEncoder", "CLIP"], clip_vision: ["CLIPVision"],
  upscale_models: ["Upscaler"], controlnet: ["Controlnet"], embeddings: ["TextualInversion"],
  // the Impact pack's detectors are Civitai's "Detection" models; its SAM files have no type of their own there
  ultralytics: ["Detection"], sams: ["Other"],
};

/** The Civitai types of a folder's models (its older name too); undefined for a folder Civitai has no type for. */
export const civitaiKinds = (folder: string): readonly CivitaiType[] | undefined => CIVITAI_KINDS[canonicalFolder(folder)];

/**
 * The folder a model of a Civitai type goes in: its first folder (a Checkpoint is a checkpoint; folderFor tells a diffusion
 * model filed as one). "Other" says no folder: it is a SAM file only when the search asked for one.
 */
export function folderOfCivitaiKind(kind: string): string | null {
  if (kind === "Other") return null;
  return Object.keys(CIVITAI_KINDS).find((folder) => CIVITAI_KINDS[folder]!.includes(kind as CivitaiType)) ?? null;
}
