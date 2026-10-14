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
