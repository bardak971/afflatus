/**
 * What a preset of the Prompt kit may bring beyond its form values: the model files it is made for, with
 * where each is fetched from, under whose licence, by whom. The built-ins stay on the official files;
 * presets are how a line of fine-tunes (one author's, say) is offered: one click in Studio, and the preset
 * itself says what is missing. The same shape whether a preset ships with Afflatus (`presets/*.json`),
 * was saved by the user, or is passed around as a file.
 */

/** One model file a preset needs. */
export interface PresetFile {
  /** Its name in ComfyUI, with a sub-folder when it has one: what the form's field holds. */
  file: string;
  /** ComfyUI's model folder ("diffusion_models", "loras"…). */
  folder: string;
  /** Fetched from an address (Hugging Face)… */
  url?: string;
  /** …or from Civitai: the version, the file's own name there when the version has several, and its page. */
  civitai?: { version: number; pick?: string; page?: string };
  /** Where it was had, when nothing above fetches it: the user is sent there. */
  page?: string;
  /** Bytes, when known. */
  size?: number;
  /** What it is for, when it is not the obvious one. */
  note?: string;
  /** The preset works without it (a LoRA that only helps). */
  optional?: boolean;
}

/** The part of a preset that says where it comes from and under what terms. */
interface PresetProvenance {
  author?: string;
  note?: string;
  /** The page that explains it (the author's). */
  homepage?: string;
  /** The author's other pages, credited beside it (their GitHub, say). */
  links?: Array<{ label: string; url: string }>;
  /** The licence of the files: shown, and accepted once, before any is fetched. */
  licence?: { name: string; url?: string; note?: string };
}

/** A preset that ships with Afflatus: a Prompt kit preset in a file. */
export interface ShippedPreset extends PresetProvenance {
  /** Lower-case letters, digits and dashes: the file's name too. */
  id: string;
  name: string;
  /** The recipe it is for ("h3.video"). */
  recipe: string;
  /** The form values it sets: at least the model file. */
  inputs: Record<string, unknown>;
  files: PresetFile[];
}
