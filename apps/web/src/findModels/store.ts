import { useCallback } from "react";
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

/** The browser's own state, kept when it closes (Esc, a click on its ✕): opened again, it is where it was. */
interface Panel {
  tab: "yours" | "civitai" | "huggingface";
  words: string;
  types: string[];
  /** The families whose base models are asked for; null: the user's families on. */
  chosenFamilies: string[] | null;
  sort: string;
  period: string;
  notMine: boolean;
  /** All of Civitai: its API leaves part of its models out unless asked (remembered in this browser). */
  all: boolean;
  hfBase: string;
  hfKind: "comfyui" | "loras" | "all";
  opened: BrowseCard | null;
  picked: PickedFile[];
}

const ALL_KEY = "afflatus.find-all";
const readAll = () => {
  try {
    return localStorage.getItem(ALL_KEY) === "1";
  } catch {
    return false;
  }
};

const usePanel = create<Panel>(() => ({
  tab: "civitai", words: "", types: ["LORA"], chosenFamilies: null, sort: "Most Downloaded", period: "AllTime", notMine: true, all: readAll(),
  hfBase: "", hfKind: "comfyui", opened: null, picked: [],
}));

/** One of the browser's kept values, read and set as useState's. */
export function useKept<K extends keyof Panel>(key: K): [Panel[K], (v: Panel[K] | ((was: Panel[K]) => Panel[K])) => void] {
  const value = usePanel((s) => s[key]);
  // the same setter at every render, as useState's
  const set = useCallback((v: Panel[K] | ((was: Panel[K]) => Panel[K])) => {
    const next = typeof v === "function" ? (v as (was: Panel[K]) => Panel[K])(usePanel.getState()[key]) : v;
    usePanel.setState({ [key]: next } as Pick<Panel, K>);
    if (key === "all") {
      try {
        localStorage.setItem(ALL_KEY, next ? "1" : "0");
      } catch {
        // kept for this visit only
      }
    }
  }, [key]);
  return [value, set];
}

/** What was picked, gone once it was added somewhere (the rest of the browser's state stays). */
export const clearPicked = () => usePanel.setState({ picked: [], opened: null });
