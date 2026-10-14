import { create } from "zustand";
import { api, type BrowseCard, type BrowseFile, type DeployFile } from "../api";

/**
 * Find models (FindModels.tsx), opened over everything from where files are picked: the Deploy dialog ("Find more…"), a
 * Model set ("Find more…"), Settings › Models ("Get models"). What it was opened for says what its main button does.
 */

/** A file picked: what a deploy, a set or a download takes, with where it comes from and what it is part of. */
export interface PickedFile extends DeployFile {
  /** Picked without a folder known (a Hugging Face file outside ComfyUI's names): the user picks one before adding. */
  folder: string;
  /** The model it is a file of ("Wan 2.2 Lightning · v2"). */
  from: string;
}

export interface FindTarget {
  /** What it was opened for, beside the title ("Deploy · RTX PRO 4000", "Video · H3"). */
  what: string;
  /** Its main button ("Add to this deploy", "Add to the set", "Get on this PC"). */
  action: string;
  add(files: PickedFile[]): void | Promise<void>;
  /** The time and price of these files, when the place knows the speeds and the rate ("~4–6 min · $0.04–0.06"). */
  estimate?(files: PickedFile[]): string | null;
  /** The target is this PC already: no "Get on this PC" beside its button. */
  pc?: boolean;
}

export const useFind = create<{ target: FindTarget | null }>(() => ({ target: null }));
export const openFindModels = (target: FindTarget) => useFind.setState({ target });
export const closeFindModels = () => useFind.setState({ target: null });

/** Where a browsed file comes from, as the rest of the app says it (a chip, a measured speed). */
export const viaOf = (f: BrowseFile): DeployFile["via"] =>
  f.source.kind === "civitai" ? "civitai" : /^https:\/\/(huggingface\.co|hf\.co)\//i.test(f.source.url) ? "hf" : "url";

/** A browsed file as picked, in the folder given (its own guess, or the user's). */
export const pickedOf = (f: BrowseFile, card: BrowseCard, version: string, folder = f.folder ?? ""): PickedFile => ({
  file: f.name, folder, via: viaOf(f), size: f.bytes || null, from: card.site === "civitai" ? `${card.name} · ${version}` : card.id,
  ...(f.source.kind === "civitai" ? { civitai: { version: f.source.version, pick: f.source.pick, page: `${card.page}?modelVersionId=${f.source.version}` } } : { url: f.source.url }),
});

/** The ComfyUI folders a file without one can be put in. */
export const FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders", "embeddings"];

/** Picked files downloaded onto this PC's ComfyUI, one after the other, as the usual downloads (Settings › Models shows them). */
export async function getOnPc(files: PickedFile[]): Promise<void> {
  for (const f of files) await api.startDownload({ file: f.file, folder: f.folder, ...(f.civitai ? { civitai: f.civitai.version, ...(f.civitai.pick ? { pick: f.civitai.pick } : {}) } : { url: f.url! }) });
}
