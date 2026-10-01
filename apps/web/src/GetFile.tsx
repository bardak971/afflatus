import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download as DownloadIcon } from "lucide-react";
import { api, type Download } from "./api";
import { useSettings } from "./data";
import { fileLabel, size } from "./format";
import { Bar, cx } from "./ui";

/** Model files being fetched into ComfyUI. Refetched when the server says one of them moved on. */
export const useDownloads = () => useQuery({ queryKey: ["downloads"], queryFn: api.downloads, staleTime: 10_000 });

const SAYS: Record<Download["status"], string> = {
  starting: "Waiting for ComfyUI-Manager to start…",
  downloading: "Downloading",
  saving: "All of it arrived. ComfyUI is saving it…",
  done: "It is in ComfyUI now.",
  error: "It did not work.",
};

/** One download as a line: what it is doing and how far it is. */
export function DownloadRow({ d, named }: { d: Download; named?: boolean }) {
  const part = d.total ? Math.min(1, d.bytes / d.total) : 0;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-raised px-2.5 py-1.5 text-ink">
      {named && <span className="font-semibold break-all">{fileLabel(d.file)} <span className="font-normal text-ink-2">into {d.folder}</span></span>}
      <span className={cx("text-xs", d.status === "error" ? "text-warn-ink" : d.status === "done" ? "text-good" : "text-ink-2")}>
        {d.status === "error" ? d.error : SAYS[d.status]}
        {d.status === "downloading" && ` · ${size(d.bytes)}${d.total ? ` of ${size(d.total)}` : ""}`}
      </span>
      {(d.status === "downloading" || d.status === "saving") && <Bar value={d.status === "saving" ? 1 : part} />}
    </div>
  );
}

const link = "font-semibold underline";

/**
 * What can be done about a model file ComfyUI does not have: fetch it into ComfyUI from the address
 * its author gave, or look for it on Civitai and fetch it from there. Both only show when they were
 * turned on in Setup; without them this renders nothing and the plain links around it stay.
 */
export function GetFile({ file, folder, url, civitai }: { file: string; folder: string | null; url?: string; /** Its Civitai version, when that is known: fetched without looking it up. */ civitai?: number }) {
  const settings = useSettings();
  const downloads = useDownloads();
  const client = useQueryClient();
  const lookups = Boolean(settings.data?.civitaiLookups);
  const fetching = Boolean(settings.data?.downloadModels) && Boolean(folder);
  const find = useMutation({ mutationFn: () => api.civitaiFind(file) });
  const start = useMutation({
    mutationFn: (from: { civitai: number } | { url: string }) => api.startDownload({ file, folder: folder!, ...from }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["downloads"] }),
  });
  const mine = downloads.data?.items.find((d) => d.file === file && d.folder === folder);
  const busy = start.isPending || (mine && mine.status !== "error" && mine.status !== "done");
  if (!lookups && !fetching) return null;

  return (
    <span className="flex flex-col gap-1.5 pt-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {fetching && url && (
          <button type="button" disabled={Boolean(busy)} onClick={() => start.mutate({ url })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download it into ComfyUI
          </button>
        )}
        {fetching && civitai && !url && (
          <button type="button" disabled={Boolean(busy)} onClick={() => start.mutate({ civitai })} className={cx(link, "flex items-center gap-1 disabled:opacity-60")}>
            <DownloadIcon size={13} /> Download it into ComfyUI
          </button>
        )}
        {lookups && (
          <button type="button" onClick={() => find.mutate()} disabled={find.isPending} className={link}>{find.isPending ? "Asking Civitai…" : "Find it on Civitai"}</button>
        )}
      </span>
      {start.isError && <span>{start.error.message}</span>}
      {mine && <DownloadRow d={mine} />}
      {find.isError && <span>{find.error.message}</span>}
      {find.data && find.data.items.length === 0 && <span className="text-ink-2">Civitai has nothing by that name. It may be on Hugging Face, or under another name.</span>}
      {find.data?.items.map((m) => (
        <span key={m.url} className="flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5 text-ink">
          <a href={m.url} target="_blank" rel="noreferrer" className="flex min-w-0 grow flex-col hover:underline">
            <span className="font-semibold">{m.name}{m.exact ? " · has a file of exactly this name" : ""}</span>
            <span className="text-xs text-ink-2">{[m.kind, m.base, m.version && `version ${m.version}`, m.bytes ? size(m.bytes) : "", m.words.length ? `trigger words: ${m.words.join(", ")}` : ""].filter(Boolean).join(" · ")}</span>
          </a>
          {fetching && m.versionId && (
            <button
              type="button"
              disabled={Boolean(busy)}
              title={m.exact ? "Fetches that file into ComfyUI." : `Fetches this model's file into ComfyUI and saves it as ${fileLabel(file)}. Only do this if it is the same model.`}
              onClick={() => start.mutate({ civitai: m.versionId! })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold hover:bg-hover disabled:opacity-60"
            >
              <DownloadIcon size={13} /> {m.exact ? "Download" : "Download as this file"}
            </button>
          )}
        </span>
      ))}
    </span>
  );
}
