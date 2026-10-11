import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download as DownloadIcon, X } from "lucide-react";
import { api, type Download } from "./api";
import { about, fileLabel, siteName, size } from "./format";
import { Bar, cx } from "./ui";
import { count, useDownloads, useGetFile, type Find } from "./useGetFile";
import { queryKeys } from "./queryKeys";

export { useDownloads };

const SAYS: Record<Download["status"], string> = {
  starting: "Waiting for ComfyUI-Manager to start…",
  downloading: "Downloading",
  saving: "Download complete. ComfyUI is saving it…",
  done: "Installed in ComfyUI.",
  error: "Download failed.",
  stopped: "Cancelled. Nothing was kept of it.",
};

/** What a line says of its state, by who downloads it. */
function says(d: Download): string {
  const ours = d.via === "afflatus" || d.via === "pack";
  if (d.status === "error") return d.error ?? SAYS.error;
  if (d.status === "starting" && d.waiting) return `Waiting its turn, ${d.waiting}: ${ours ? "Afflatus downloads two files at a time" : "ComfyUI-Manager fetches one file at a time"}`;
  if (d.status === "starting" && d.via === "afflatus") return "Starting…";
  if (d.status === "starting" && d.via === "pack") return "Waiting for the Afflatus node pack to start…";
  if (d.status === "saving" && ours) return "Download complete. Waiting for ComfyUI to list it…";
  return SAYS[d.status];
}

/** Who downloads it and where to, in a few words. */
const route = (d: Download) =>
  d.via === "afflatus" ? `Afflatus downloads it into ${d.into ?? d.folder}` : d.via === "pack" ? `The Afflatus node pack downloads it into ${d.into ?? d.folder}` : "Through ComfyUI-Manager";

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
  const stop = useMutation({ mutationFn: () => api.stopDownload(d.id), onSettled: () => client.invalidateQueries({ queryKey: queryKeys.downloads() }) });
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
        {says(d)}
        {/* ComfyUI-Manager reading Hugging Face itself says nothing of its bytes until the file is there */}
        {d.status === "downloading" && (d.bytes > 0 || d.via !== "manager") && ` · ${size(d.bytes)}${d.total ? ` of ${size(d.total)}` : ""}`}
        {d.status === "downloading" && speed > 0 && ` · ${speed < 2 ** 20 ? `${Math.round(speed / 1024)} KB` : `${(speed / 2 ** 20).toFixed(1)} MB`}/s${left ? ` · ${left}` : ""}`}
        {d.status === "downloading" && speed > 0 && speed < 300 * 1024 && " · slow server"}
      </span>
      {(d.status === "downloading" || d.status === "saving") && <Bar value={d.status === "saving" ? 100 : part * 100} />}
      {running && (d.note || d.via) && (
        <span className={cx("text-xs break-all", d.note && /may fail/.test(d.note) ? "text-warn-ink" : "text-ink-3")}>{[d.note, route(d)].filter(Boolean).join(" · ")}</span>
      )}
    </div>
  );
}

const link = "font-semibold underline";

/** A file of exactly the name asked for on Hugging Face, as a line that opens its page; `children` is its download button. */
export function HfMatch({ h, children }: { h: Find["exact"][number]; children?: ReactNode }) {
  return (
    <span className="flex items-center gap-2 rounded-md border border-good/50 bg-raised px-2.5 py-1.5 text-ink">
      <a href={h.page} target="_blank" rel="noreferrer" className="flex min-w-0 grow flex-col hover:underline">
        <span className="font-semibold break-all">{h.repo}</span>
        <span className="text-xs break-all text-ink-2">
          {h.path} · {count(h.downloads)} downloads{h.repo.startsWith("Comfy-Org/") ? " · ComfyUI's own repository" : ""}
          {h.gated ? " · gated: needs a Hugging Face account that accepted its terms, download it in your browser" : ""}
        </span>
      </a>
      {children}
    </span>
  );
}

/** A model with a close name on Civitai (or a site like it), as a line that opens its page; `children` is its download button. */
export function CivitaiMatch({ m, folder, children }: { m: Find["items"][number]; folder: string | null; children?: ReactNode }) {
  return (
    <span className="flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5 text-ink">
      <a href={m.url} target="_blank" rel="noreferrer" className="flex min-w-0 grow flex-col hover:underline">
        <span className="font-semibold">{m.name}{m.exact ? " · has a file of exactly this name" : ""}</span>
        <span className="text-xs text-ink-2">{[m.kind, m.base, m.version && `version ${m.version}`, m.bytes ? size(m.bytes) : "", siteName(m.site) !== "Civitai" ? `on ${siteName(m.site)}` : "", m.words.length ? `trigger words: ${m.words.join(", ")}` : ""].filter(Boolean).join(" · ")}</span>
        {m.have && (
          <span className="text-xs font-semibold text-good">
            You already have this file, in ComfyUI's "{m.have.folder}" folder.{" "}
            {m.have.folder === folder ? "Pick it under \"Replace with\"." : `This loader does not look there: it only looks in "${folder ?? "its own folder"}".`}
          </span>
        )}
        {m.file && <span className="text-xs break-all text-ink-2">file: {m.file}{!m.exact && m.of > 0 ? ` · ${m.hits.length} of ${m.of} words of the name match${m.hits.length ? ` (${m.hits.join(", ")})` : ""}` : ""}</span>}
      </a>
      {children}
    </span>
  );
}

/** What the Civitai matches of a lookup are, in a sentence: whether one has the file itself, or only close names. */
export const civitaiSays = (data: Find) =>
  data.items.some((m) => m.exact)
    ? "The first one has a file of exactly this name."
    : data.items.some((m) => m.fits)
      ? "None has a file of exactly this name. The closest names come first: take the one made for the same base model, shown after its type. It is saved under the filename that is asked for."
      : "Nothing of the right model type was found, only these.";

/** What a Civitai match's download button says it does. */
export const civitaiTip = (m: Find["items"][number], file: string) =>
  m.exact ? "Downloads that file into ComfyUI." : `Downloads this model's file into ComfyUI and saves it as ${fileLabel(file)}. Only do this if it is the same model.`;

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
  const { lookups, fetching, find, search, start, download, mine, busy, noRoute, why, caution } = useGetFile({ file, folder, url, civitai, pick, hints, auto });
  if (!lookups && !fetching) return null;

  return (
    <span className="flex flex-col gap-1.5 pt-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {fetching && url && (
          <button type="button" disabled={busy || noRoute} data-tip={why} onClick={() => download({ url })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download into ComfyUI
          </button>
        )}
        {fetching && civitai && !url && (
          <button type="button" disabled={busy || noRoute} data-tip={why} onClick={() => download({ civitai })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download into ComfyUI
          </button>
        )}
        {lookups && (
          <button type="button" onClick={search} disabled={find.isPending} className={link} data-tip="Asks Hugging Face for a file of exactly this name, and Civitai for models with a close name.">{find.isPending ? "Searching…" : "Search"}</button>
        )}
      </span>
      {fetching && caution && !mine && (url || civitai) && <span className="text-xs text-warn-ink">{caution}</span>}
      {start.isError && <span>{start.error.message}</span>}
      {mine && <DownloadRow d={mine} />}
      {find.isError && <span>{find.error.message}</span>}
      {find.data && find.data.exact.length > 0 && (
        <>
          <span className="font-semibold text-good">Exact filename match on Hugging Face.</span>
          {find.data.exact.map((h) => (
            <HfMatch key={h.url} h={h}>
              {fetching && !h.gated && (
                <button type="button" disabled={busy} onClick={() => download({ url: h.url })} className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold hover:bg-hover disabled:opacity-60">
                  <DownloadIcon size={13} /> Download
                </button>
              )}
            </HfMatch>
          ))}
        </>
      )}
      {find.data && find.data.items.length === 0 && find.data.exact.length === 0 && <span className="text-ink-2">No match for that filename ({find.data.asked.join(", ")} {find.data.asked.length === 1 ? "was" : "were"} asked). It may be under another name.</span>}
      {find.data && find.data.items.length > 0 && find.data.exact.length > 0 && <span className="pt-1 text-ink-2">Other models with a close name, on Civitai (not needed when the file above is the one):</span>}
      {find.data && find.data.items.length > 0 && find.data.exact.length === 0 && (
        <span className="text-ink-2">
          {civitaiSays(find.data)}
          {find.data.silent.length > 0 && ` (${find.data.silent.join(" and ")} did not answer.)`}
        </span>
      )}
      {find.data?.items.map((m) => (
        <CivitaiMatch key={m.url} m={m} folder={folder}>
          {fetching && m.versionId && (m.fits || m.exact) && !m.have && (
            <button
              type="button"
              disabled={busy}
              data-tip={civitaiTip(m, file)}
              onClick={() => download({ civitai: m.versionId! })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold hover:bg-hover disabled:opacity-60"
            >
              <DownloadIcon size={13} /> {m.exact ? "Download" : "Download as this filename"}
            </button>
          )}
        </CivitaiMatch>
      ))}
    </span>
  );
}
