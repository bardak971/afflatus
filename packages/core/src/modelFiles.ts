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

/** A model file's name without its folder and without its extension: "Wan\\wan_2.1_vae.safetensors" → "wan_2.1_vae". */
/**
 * One model file wherever it is said, by its folder and its name without its sub-folder, lower case: a job's file, a
 * preset's, a set's and a pod's are the same file when this is the same (a pod lists a file by its name in the folder).
 */
export const fileKey = (f: { folder: string; file: string }) => `${f.folder}|${(f.file.split(/[\\/]/).pop() ?? f.file).toLowerCase()}`;

export const modelStem = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(MODEL_EXT, "");

/** The families' downloads (their slots' `get`), as the server and the web both have them. */
type Downloads = ReadonlyArray<{ slots?: ReadonlyArray<{ get?: { file: string; url: string } }> }>;

const nameOf = (file: string) => (file.split(/[\/]/).pop() ?? file).toLowerCase();

/** Whether `file` is a family's official file by its name (a slot's download), whatever its sub-folder or case. */
export const isOfficialName = (families: Downloads, file: string): boolean =>
  families.some((f) => (f.slots ?? []).some((x) => x.get !== undefined && nameOf(x.get.file) === nameOf(file)));

/**
 * Whether `url` is a family's own official file for `file` (a slot's `get`): the same address, and a file of the same name
 * whatever its sub-folder or case. Fetching it is no lookup, the address is the family's own, so the server fetches it
 * whatever the downloads and lookups settings say (a Download pressed on it, or a pod getting it for a deploy or a queued
 * job), and the web offers its Download on the same terms. The folder is not asked: it says where the file lands, not
 * what is fetched, and a shipped preset loads a family's checkpoint as a diffusion model (LTX 2.3 distilled). The planner
 * gave that file its official address and sent it to a pod, whose fetch then refused it as no official file of that
 * folder, the pod billed while it waited (2026-10-22). The web and the server each had a test of their own, apart.
 */
export const isOfficialFile = (families: Downloads, want: { url?: string; file: string }): boolean =>
  Boolean(want.url) && families.some((f) => (f.slots ?? []).some((x) => x.get !== undefined && x.get.url === want.url && nameOf(x.get.file) === nameOf(want.file)));
