import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useSettings } from "./data";
import { siteName } from "./format";
import { queryKeys } from "./queryKeys";

/** Model files being fetched into ComfyUI. Refetched when the server says one of them moved on. */
export const useDownloads = () => useQuery({ queryKey: queryKeys.downloads(), queryFn: api.downloads, staleTime: 10_000 });

export type Find = Awaited<ReturnType<typeof api.civitaiFind>>;
/** Where a download comes from: the address, or a Civitai version. */
export type From = { url: string } | { civitai: number };
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
  const downloads = useDownloads();
  const client = useQueryClient();
  const lookups = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels) && Boolean(folder);
  const find = useMutation({ mutationFn: () => api.civitaiFind(file, folder, hints) });
  const start = useMutation({
    mutationFn: (from: From) => api.startDownload({ file, folder: folder!, ...from, ...("civitai" in from && pick ? { pick } : {}) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.downloads() }),
  });
  const mine = downloads.data?.items.find((d) => d.file === file && d.folder === folder);
  const busy = start.isPending || Boolean(mine && (mine.status === "starting" || mine.status === "downloading" || mine.status === "saving"));
  // the download runs through ComfyUI-Manager: without it in ComfyUI the button would only fail
  const noManager = downloads.data?.manager.found === false;
  const why = noManager ? "ComfyUI-Manager was not found in your ComfyUI: install it first (Settings → Models → Missing models says how), then Test again in Settings → ComfyUI." : undefined;
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
    noManager,
    /** Why the download buttons are off, when it is the missing ComfyUI-Manager. */
    why,
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
      from: { civitai: cv.versionId! },
      // the model's name, for a close one: the link is what is offered, and "close name" alone left it to guess which
      what: cv.exact ? `exact match on ${siteName(cv.site)}` : `a file with a close name is on ${siteName(cv.site)}: ${cv.name}`,
      page: cv.url,
      bytes: cv.bytes || undefined,
      tip: [cv.name, cv.kind, cv.base, cv.version && `version ${cv.version}`, cv.file && `file: ${cv.file}`, !cv.exact && "Saved under the filename the workflow asks for. Only take it if it is the same model."].filter(Boolean).join(" · "),
    };
  }
  return null;
}
