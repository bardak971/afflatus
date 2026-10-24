import { useCallback } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api, type BrowseCard, type BrowseFile, type DeployFile } from "../api";
import { queryKeys } from "../queryKeys";

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
/** Find models opened for a place; `words`: what to search for (the command bar's `> find models …`), kept as it was otherwise. */
export const openFindModels = (target: FindTarget, words?: string) => {
  if (words !== undefined) usePanel.setState({ words, opened: null });
  useFind.setState({ target });
};
export const closeFindModels = () => useFind.setState({ target: null });

/** Where a browsed file comes from, as the rest of the app says it (a chip, a measured speed). */
export const viaOf = (f: BrowseFile): DeployFile["via"] =>
  f.source.kind === "civitai" ? "civitai" : /^https:\/\/(huggingface\.co|hf\.co)\//i.test(f.source.url) ? "hf" : "url";

/** A browsed file as picked, in the folder given (its own guess, or the user's). */
export const pickedOf = (f: BrowseFile, card: BrowseCard, version: string, folder = f.folder ?? ""): PickedFile => ({
  file: f.name, folder, via: viaOf(f), size: f.bytes || null, from: card.site === "civitai" ? `${card.name} · ${version}` : card.id,
  ...(f.source.kind === "civitai" ? { civitai: { version: f.source.version, pick: f.source.pick, page: `${card.page}?modelVersionId=${f.source.version}` } } : { url: f.source.url }),
});

/** The ComfyUI folders a file without one can be put in, until the server says its ComfyUI's own (and when it does not answer). */
export const FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders", "embeddings"];

const foldersQuery = (machine?: string) => ({ queryKey: queryKeys.browse.folders(machine), queryFn: ({ signal }: { signal: AbortSignal }) => api.browseFolders(machine, { signal }).then((r) => r.folders), staleTime: 60_000 });
/** The folders a picked file can go in: this PC's ComfyUI's own with the usual and the families' (frame_interpolation for RIFE). */
export const useFolders = (machine?: string): string[] => useQuery(foldersQuery(machine)).data ?? FOLDERS;
/** The same, asked once for a question (the command bar's "Which folder?"): the usual ones when the server does not answer. */
export const foldersFor = (client: QueryClient, machine?: string): Promise<string[]> => client.fetchQuery(foldersQuery(machine)).catch(() => FOLDERS);

/**
 * Picked files downloaded onto this PC's ComfyUI as the usual downloads (Settings › Models shows them), all asked for at
 * once: one refused does not stop the others. Gives back the files that were not started, each with why, so that only
 * they stay picked for another try (a file started twice would download twice).
 */
export async function getOnPc(files: PickedFile[]): Promise<Array<{ file: PickedFile; error: unknown }>> {
  const tried = await Promise.allSettled(files.map((f) => api.startDownload({ file: f.file, folder: f.folder, ...(f.civitai ? { civitai: f.civitai.version, ...(f.civitai.pick ? { pick: f.civitai.pick } : {}) } : { url: f.url! }) })));
  return tried.flatMap((t, i) => (t.status === "rejected" ? [{ file: files[i]!, error: t.reason as unknown }] : []));
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
  hfSort: HfSort;
  /** One creator's models only (Civitai's user, Hugging Face's user or organisation): the command bar's by:. */
  by: string;
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
  hfBase: "", hfKind: "comfyui", hfSort: "downloads", by: "", opened: null, picked: [],
}));

/** Hugging Face's orders, as its API names them. */
export type HfSort = "downloads" | "likes" | "lastModified" | "trendingScore";

/** What the command bar opens the browser on (`civitai: … type:lora base:klein by:someone`): its tab, words and filters, a model opened. */
export type FindAsk = Partial<Pick<Panel, "tab" | "words" | "types" | "chosenFamilies" | "sort" | "period" | "all" | "hfBase" | "hfKind" | "hfSort" | "by" | "opened">>;
/** The browser opened on a search of the command bar's: what it does not say is left as it was, but the creator and the model opened. */
export const openFindModelsOn = (target: FindTarget, ask: FindAsk) => {
  usePanel.setState({ by: "", opened: null, ...ask });
  useFind.setState({ target });
};

/** What is picked now, and a file added to it (the bar's Add to Picked): once, by its file and source. */
export const pickedNow = () => usePanel.getState().picked;
export const addPicked = (f: PickedFile): boolean => {
  const now = usePanel.getState().picked;
  if (now.some((p) => p.file === f.file && p.folder === f.folder)) return false;
  usePanel.setState({ picked: [...now, f] });
  return true;
};
/** Picked files taken off (the bar's Get them, once they started). */
export const dropPicked = (files: readonly PickedFile[]) => usePanel.setState((s) => ({ picked: s.picked.filter((p) => !files.includes(p)) }));
/** Whatever the bar picked is shown here too: subscribed, for `> picked`'s count. */
export const usePickedCount = () => usePanel((s) => s.picked.length);

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
