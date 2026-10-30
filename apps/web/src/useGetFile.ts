import { createContext, useContext, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isOfficialFile } from "@afflatus/core";
import { api } from "./api";
import { civitaiExact } from "./findModels/store";
import { useRecipes, useSettings } from "./data";
import { siteName } from "./format";
import { queryKeys } from "./queryKeys";

/** Model files being fetched into ComfyUI. Refetched when the server says one of them moved on. */
export const useDownloads = (machine?: string) => useQuery({ queryKey: queryKeys.downloads(machine), queryFn: ({ signal }) => api.downloads({ signal }, machine), staleTime: 10_000 });

/**
 * The ComfyUI a GetFile below downloads into, with several (Settings › Models on one machine's tab, a waiting job's files
 * for the machine it is pinned to); none: the first.
 */
export const DownloadTo = createContext<string | undefined>(undefined);

export type Find = Awaited<ReturnType<typeof api.civitaiFind>>;

/** Why nothing can download into this ComfyUI, and what to do about it. */
export const NO_ROUTE = "Nothing can download into this ComfyUI: Afflatus cannot write its model folders, it has no Afflatus node pack 0.11 or newer loaded, and ComfyUI-Manager was not found. Set ComfyUI's folder in Settings › ComfyUI (ComfyUI on this machine), restart ComfyUI to load the node pack, or install ComfyUI-Manager (Settings › Models › Missing models says how).";
/** What is said before a download that ComfyUI-Manager would do: it holds a file in RAM before writing it. */
export const MANAGER_CAUTION = "Downloads go through ComfyUI-Manager, which holds a file from anywhere but Hugging Face in RAM before writing it: over 1 GB it may fail. To download straight to disk, set ComfyUI's folder in Settings › ComfyUI (ComfyUI on this machine), or restart ComfyUI to load the updated Afflatus node pack."
/** Where a download comes from: the address, or a Civitai version (with its file's hash and id when a search found it). */
export type From = { url: string } | { civitai: number; sha256?: string; fileId?: number };
/** The download to offer first, and what it is. */
export interface Best { key: string; from: From; what: string; tip?: string; page?: string; bytes?: number }

/** A count of downloads, in words that read at a glance. */
export const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1000 ? `${Math.round(n / 1000)} thousand` : String(n));

/**
 * Fetching a model file ComfyUI does not have into it, and looking it up on Hugging Face and Civitai: the one
 * implementation behind GetFile (Settings → Models, recipe forms) and the workflow editor's "Before it can run".
 */
export function useGetFile({ file, folder, url, civitai, pick, hints, auto, source }: {
  file: string;
  folder: string | null;
  url?: string;
  /** Its Civitai version, when that is known: fetched without looking it up. */
  civitai?: number;
  /** Of a Civitai version with several files: the one to fetch, by the name Civitai gives it. */
  pick?: string;
  /** Words that say which model the file is for (a loader's type, the model's name): they help find the repository that has it. */
  hints?: string[];
  /** Look the file up as soon as this shows, rather than on a click. */
  auto?: boolean;
  /** Of the Civitai version named: whether its file is this one, for what the best download says. */
  source?: { exact: boolean; file: string };
}) {
  const settings = useSettings();
  const machine = useContext(DownloadTo);
  const downloads = useDownloads(machine);
  const client = useQueryClient();
  const lookups = Boolean(settings.data?.civitaiLookups);
  // a family's own file at its own address is downloaded on a press whatever the settings (the press is the consent, and
  // no lookup is made): what a greyed file in a form, a waiting job and Settings › Models offer, by the server's own test
  const recipes = useRecipes();
  const official = isOfficialFile(recipes.data?.families ?? [], { url, file });
  // anything else needs downloads on, as the server does (fetchFile.ts beginDownload): the press is the user asking, whatever
  // "Search Hugging Face and Civitai" says (card #166)
  const fetching = (Boolean(settings.data?.downloadModels) || official) && Boolean(folder);
  const find = useMutation({ mutationFn: () => api.civitaiFind(file, folder, hints) });
  const start = useMutation({
    mutationFn: (from: From) => api.startDownload({ file, folder: folder!, ...from, ...("civitai" in from && pick ? { pick } : {}), ...(machine ? { machine } : {}) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.downloads() }),
  });
  const mine = downloads.data?.items.find((d) => d.file === file && d.folder === folder && (!machine || d.machine === machine));
  const busy = start.isPending || Boolean(mine && (mine.status === "starting" || mine.status === "downloading" || mine.status === "saving"));
  // Afflatus, its node pack or ComfyUI-Manager does the download: with none of them the button would only fail
  const noRoute = downloads.data?.via === "none";
  const why = noRoute ? NO_ROUTE : undefined;
  const caution = downloads.data?.via === "manager" ? MANAGER_CAUTION : undefined;
  const looked = useRef(false);
  useEffect(() => {
    if (auto && lookups && !url && !civitai && !looked.current) {
      looked.current = true;
      find.mutate();
    }
    // once, when it shows and lookups are on
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it shows and lookups are on
  }, [auto, lookups]);

  return {
    /** Looking up is turned on in Settings. */
    lookups,
    /** Downloading is turned on in Settings, and the file has a folder to go to. */
    fetching,
    /** The lookup: its answer (`data`), `isPending`, `isError`/`error`. */
    find,
    search: () => find.mutate(),
    /** Starting a download: `isPending`, `isError`/`error`. */
    start,
    download: (from: From) => start.mutate(from),
    /** This file's download, when there is one. */
    mine,
    busy,
    noRoute,
    /** Why the download buttons are off, when nothing can download. */
    why,
    /** What to know before downloading, when ComfyUI-Manager would do it. */
    caution,
    best: bestOf({ fetching, url, civitai, source, data: find.data }),
  };
}

/**
 * The download to offer first, in the order the full list has them: the address given, the Civitai version
 * named, an exact filename on Hugging Face, then the first Civitai match that can be fetched.
 */
function bestOf({ fetching, url, civitai, source, data }: { fetching: boolean; url?: string; civitai?: number; source?: { exact: boolean; file: string }; data?: Find }): Best | null {
  if (!fetching) return null;
  // these two are said by what is around the button (the address, or where the Civitai version was found)
  if (url) return { key: `url:${url}`, from: { url }, what: "", tip: "Downloads it into ComfyUI." };
  if (civitai) return { key: `civitai:${civitai}`, from: { civitai }, what: "", tip: !source || source.exact ? "Downloads that file into ComfyUI." : `Its file is ${source.file}, not this one: take it only if it is the same model.` };
  const hf = data?.exact.find((h) => !h.gated);
  if (hf) return { key: `hf:${hf.url}`, from: { url: hf.url }, what: "exact match on Hugging Face", page: hf.page, tip: `${hf.repo}/${hf.path} · ${count(hf.downloads)} downloads${hf.repo.startsWith("Comfy-Org/") ? " · ComfyUI's own repository" : ""}` };
  const cv = data?.items.find((c) => c.versionId && (c.fits || c.exact) && !c.have);
  if (cv) {
    return {
      key: `cv:${cv.url}`,
      from: { civitai: cv.versionId!, ...civitaiExact(cv) },
      // the model's name, for a close one: the link is what is offered, and "close name" alone left it to guess which
      what: cv.exact ? `exact match on ${siteName(cv.site)}` : `a file with a close name is on ${siteName(cv.site)}: ${cv.name}`,
      page: cv.url,
      bytes: cv.bytes || undefined,
      tip: [cv.name, cv.kind, cv.base, cv.version && `version ${cv.version}`, cv.file && `file: ${cv.file}`, !cv.exact && "Saved under the filename the workflow asks for. Only take it if it is the same model."].filter(Boolean).join(" · "),
    };
  }
  return null;
}
