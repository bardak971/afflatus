import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download as DownloadIcon, X } from "lucide-react";
import { api, type Download } from "./api";
import { useSettings } from "./data";
import { about, fileLabel, size } from "./format";
import { Bar, cx } from "./ui";

/** Model files being fetched into ComfyUI. Refetched when the server says one of them moved on. */
export const useDownloads = () => useQuery({ queryKey: ["downloads"], queryFn: api.downloads, staleTime: 10_000 });

const SAYS: Record<Download["status"], string> = {
  starting: "Waiting for ComfyUI-Manager to start…",
  downloading: "Downloading",
  saving: "Download complete. ComfyUI is saving it…",
  done: "Installed in ComfyUI.",
  error: "Download failed.",
  stopped: "Cancelled. Nothing was kept of it.",
};

/** One download as a line: what it is doing and how far it is. */
export function DownloadRow({ d, named }: { d: Download; named?: boolean }) {
  const part = d.total ? Math.min(1, d.bytes / d.total) : 0;
  // how fast it comes, from one reading to the next, evened out: a slow site then reads as slow, not as stuck
  const last = useRef({ bytes: d.bytes, at: Date.now(), speed: 0 });
  const [speed, setSpeed] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const seconds = (now - last.current.at) / 1000;
    if (seconds < 0.4 || d.bytes < last.current.bytes) return;
    const just = (d.bytes - last.current.bytes) / seconds;
    last.current = { bytes: d.bytes, at: now, speed: last.current.speed ? last.current.speed * 0.6 + just * 0.4 : just };
    setSpeed(last.current.speed);
  }, [d.bytes]);
  const left = speed > 0 && d.total > d.bytes ? about((d.total - d.bytes) / speed) : "";
  const client = useQueryClient();
  const stop = useMutation({ mutationFn: () => api.stopDownload(d.id), onSettled: () => client.invalidateQueries({ queryKey: ["downloads"] }) });
  const running = d.status === "starting" || d.status === "downloading";
  return (
    <div className="relative flex flex-col gap-1 rounded-md border border-line bg-raised py-1.5 pr-9 pl-2.5 text-ink">
      {d.status !== "saving" && (
        <button
          type="button"
          aria-label={running ? `Cancel the download of ${fileLabel(d.file)}` : "Dismiss"}
          data-tip={running ? "Cancel it. Nothing is kept of a cancelled download." : "Dismiss"}
          disabled={stop.isPending}
          onClick={() => stop.mutate()}
          className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
      {named && <span className="font-semibold break-all">{fileLabel(d.file)} <span className="font-normal text-ink-2">into {d.folder}</span></span>}
      {stop.isError && <span className="text-xs text-warn-ink">{stop.error.message}</span>}
      <span className={cx("text-xs", d.status === "error" ? "text-warn-ink" : d.status === "done" ? "text-good" : "text-ink-2")}>
        {d.status === "error" ? d.error : d.status === "starting" && d.waiting ? `Waiting its turn, ${d.waiting}: ComfyUI-Manager fetches one file at a time` : SAYS[d.status]}
        {d.status === "downloading" && ` · ${size(d.bytes)}${d.total ? ` of ${size(d.total)}` : ""}`}
        {d.status === "downloading" && speed > 0 && ` · ${speed < 2 ** 20 ? `${Math.round(speed / 1024)} KB` : `${(speed / 2 ** 20).toFixed(1)} MB`}/s${left ? ` · ${left}` : ""}`}
        {d.status === "downloading" && speed > 0 && speed < 300 * 1024 && " · slow server"}
      </span>
      {(d.status === "downloading" || d.status === "saving") && <Bar value={d.status === "saving" ? 100 : part * 100} />}
    </div>
  );
}

const link = "font-semibold underline";

/**
 * What can be done about a model file ComfyUI does not have: fetch it into ComfyUI from the address
 * its author gave, or look for it on Civitai and fetch it from there. Both only show when they were
 * turned on in Settings; without them this renders nothing and the plain links around it stay.
 */
export function GetFile({ file, folder, url, civitai, pick, hints, auto }: {
  file: string;
  /** Look the file up as soon as this shows, rather than on a click (the import page, where nothing else says where it is). */
  auto?: boolean;
  folder: string | null;
  url?: string;
  /** Its Civitai version, when that is known: fetched without looking it up. */
  civitai?: number;
  /** Of a Civitai version with several files: the one to fetch, by the name Civitai gives it. */
  pick?: string;
  /** Words that say which model the file is for (a loader's type, the model's name): they help find the repository that has it. */
  hints?: string[];
}) {
  const settings = useSettings();
  const downloads = useDownloads();
  const client = useQueryClient();
  const lookups = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels) && Boolean(folder);
  const find = useMutation({ mutationFn: () => api.civitaiFind(file, folder, hints) });
  const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1000 ? `${Math.round(n / 1000)} thousand` : String(n));
  const start = useMutation({
    mutationFn: (from: { civitai: number } | { url: string }) => api.startDownload({ file, folder: folder!, ...from, ...("civitai" in from && pick ? { pick } : {}) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["downloads"] }),
  });
  const mine = downloads.data?.items.find((d) => d.file === file && d.folder === folder);
  const busy = start.isPending || (mine && (mine.status === "starting" || mine.status === "downloading" || mine.status === "saving"));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, lookups]);
  if (!lookups && !fetching) return null;

  return (
    <span className="flex flex-col gap-1.5 pt-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {fetching && url && (
          <button type="button" disabled={Boolean(busy) || noManager} data-tip={why} onClick={() => start.mutate({ url })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download into ComfyUI
          </button>
        )}
        {fetching && civitai && !url && (
          <button type="button" disabled={Boolean(busy) || noManager} data-tip={why} onClick={() => start.mutate({ civitai })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download into ComfyUI
          </button>
        )}
        {lookups && (
          <button type="button" onClick={() => find.mutate()} disabled={find.isPending} className={link} data-tip="Asks Hugging Face for a file of exactly this name, and Civitai for models with a close name.">{find.isPending ? "Searching…" : "Search"}</button>
        )}
      </span>
      {start.isError && <span>{start.error.message}</span>}
      {mine && <DownloadRow d={mine} />}
      {find.isError && <span>{find.error.message}</span>}
      {find.data && find.data.exact.length > 0 && (
        <>
          <span className="font-semibold text-good">Exact filename match on Hugging Face.</span>
          {find.data.exact.map((h) => (
            <span key={h.url} className="flex items-center gap-2 rounded-md border border-good/50 bg-raised px-2.5 py-1.5 text-ink">
              <a href={h.page} target="_blank" rel="noreferrer" className="flex min-w-0 grow flex-col hover:underline">
                <span className="font-semibold break-all">{h.repo}</span>
                <span className="text-xs break-all text-ink-2">
                  {h.path} · {count(h.downloads)} downloads{h.repo.startsWith("Comfy-Org/") ? " · ComfyUI's own repository" : ""}
                  {h.gated ? " · gated: needs a Hugging Face account that accepted its terms, download it in your browser" : ""}
                </span>
              </a>
              {fetching && !h.gated && (
                <button type="button" disabled={Boolean(busy)} onClick={() => start.mutate({ url: h.url })} className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold hover:bg-hover disabled:opacity-60">
                  <DownloadIcon size={13} /> Download
                </button>
              )}
            </span>
          ))}
        </>
      )}
      {find.data && find.data.items.length === 0 && find.data.exact.length === 0 && <span className="text-ink-2">No match for that filename ({find.data.asked.join(", ")} {find.data.asked.length === 1 ? "was" : "were"} asked). It may be under another name.</span>}
      {find.data && find.data.items.length > 0 && find.data.exact.length > 0 && <span className="pt-1 text-ink-2">Other models with a close name, on Civitai (not needed when the file above is the one):</span>}
      {find.data && find.data.items.length > 0 && find.data.exact.length === 0 && (
        <span className="text-ink-2">
          {find.data.items.some((m) => m.exact)
            ? "The first one has a file of exactly this name."
            : find.data.items.some((m) => m.fits)
              ? "None has a file of exactly this name. The closest names come first: take the one made for the same base model, shown after its type. It is saved under the filename that is asked for."
              : "Nothing of the right model type was found, only these."}
          {find.data.silent.length > 0 && ` (${find.data.silent.join(" and ")} did not answer.)`}
        </span>
      )}
      {find.data?.items.map((m) => (
        <span key={m.url} className="flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5 text-ink">
          <a href={m.url} target="_blank" rel="noreferrer" className="flex min-w-0 grow flex-col hover:underline">
            <span className="font-semibold">{m.name}{m.exact ? " · has a file of exactly this name" : ""}</span>
            <span className="text-xs text-ink-2">{[m.kind, m.base, m.version && `version ${m.version}`, m.bytes ? size(m.bytes) : "", m.site !== "civitai.com" ? `on ${m.site}` : "", m.words.length ? `trigger words: ${m.words.join(", ")}` : ""].filter(Boolean).join(" · ")}</span>
            {m.have && (
              <span className="text-xs font-semibold text-good">
                You already have this file, in ComfyUI's "{m.have.folder}" folder.{" "}
                {m.have.folder === folder ? "Pick it under \"Replace with\"." : `This loader does not look there: it only looks in "${folder ?? "its own folder"}".`}
              </span>
            )}
            {m.file && <span className="text-xs break-all text-ink-2">file: {m.file}{!m.exact && m.of > 0 ? ` · ${m.hits.length} of ${m.of} words of the name match${m.hits.length ? ` (${m.hits.join(", ")})` : ""}` : ""}</span>}
          </a>
          {fetching && m.versionId && (m.fits || m.exact) && !m.have && (
            <button
              type="button"
              disabled={Boolean(busy)}
              data-tip={m.exact ? "Downloads that file into ComfyUI." : `Downloads this model's file into ComfyUI and saves it as ${fileLabel(file)}. Only do this if it is the same model.`}
              onClick={() => start.mutate({ civitai: m.versionId! })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold hover:bg-hover disabled:opacity-60"
            >
              <DownloadIcon size={13} /> {m.exact ? "Download" : "Download as this filename"}
            </button>
          )}
        </span>
      ))}
    </span>
  );
}
