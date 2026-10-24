import { useEffect, useRef } from "react";
import { ChevronRight, Download as DownloadIcon } from "lucide-react";
import { folderOfFileInput } from "@afflatus/core";
import { api } from "../../api";
import { civitaiExact } from "../../findModels/store";
import { fileLabel, plural, size } from "../../format";
import { CivitaiMatch, civitaiSays, civitaiTip, DownloadRow, HfMatch } from "../../GetFile";
import { Select } from "../../Select";
import { Button, cx, Help } from "../../ui";
import { useGetFile } from "../../useGetFile";
import { searchLinks } from "./parts";
import type { Mapping } from "./useMapping";

type MissingFileOf = Mapping["found"]["missingFiles"][number];

const small = "text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink";

/**
 * A model file this ComfyUI does not have, as one compact block of "Before it can run": its name with what it is
 * behind a "?", a "Replace with…" picker and the best download on one line, and the other ways to find it small
 * under them. The other matches a search found stay one click away, folded. Fetching and looking up are GetFile's
 * (useGetFile, its rows): the same ones, laid out for the narrow column.
 */
export function MissingFile({ f, m, hints, where }: { f: MissingFileOf; m: Mapping; hints: string[]; where: string }) {
  const { graph, replaceFile } = m;
  const now = String(graph[f.node]?.inputs[f.input] ?? f.file);
  const replaced = now !== f.file;
  const folder = folderOfFileInput(f.classType, f.input);

  const civitai = f.source?.civitai;
  // looked up as soon as it shows, when nothing else says where it is
  const { lookups, fetching, find, search, start, download, mine, busy, noRoute, why, caution, best } = useGetFile({
    file: f.file,
    folder,
    url: f.url ?? f.source?.url,
    civitai,
    pick: civitai ? f.source?.file : undefined,
    hints,
    auto: !f.url && !f.source && !replaced,
    source: f.source,
  });
  const moreHf = (find.data?.exact ?? []).filter((h) => `hf:${h.url}` !== best?.key);
  const moreCivitai = (find.data?.items ?? []).filter((c) => `cv:${c.url}` !== best?.key);
  const more = moreHf.length + moreCivitai.length;

  // fetched: the workflow is read again, so it no longer counts as missing and "Replace with…" lists it
  const reread = useRef<string | null>(null);
  const done = mine?.status === "done" ? mine.id : null;
  useEffect(() => {
    if (!done || reread.current === done) return;
    reread.current = done;
    api.inspectWorkflow(m.start.editor ?? { graph: m.graph, wiring: m.wiring }).then(m.reread, () => {});
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps -- read again once per download done, not when the mapping changes

  const what = [
    `Your ComfyUI does not have ${fileLabel(f.file)} (${f.label}).`,
    f.url ? "The workflow gives the address to download it from." : f.source ? sourceSays(f.source) : "",
    where,
  ].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cx("min-w-0 truncate font-mono text-meta font-semibold", replaced && "text-ink-3 line-through")} data-tip={f.file}>{fileLabel(f.file)}</span>
        <span className="shrink-0 text-xs text-ink-3">{replaced ? "replaced" : f.label}</span>
        <Help title={fileLabel(f.file)} text={replaced ? `${what} It is replaced by ${fileLabel(now)}.` : what} />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 grow">
          <Select
            size="sm"
            label={`File to use instead of ${fileLabel(f.file)}`}
            placeholder="Replace with…"
            value={replaced ? now : ""}
            onChange={(file) => replaceFile(f, file || f.file)}
            options={[...(replaced ? [{ value: "", label: "Back to the file the workflow names" }] : []), ...f.options.map((o) => ({ value: o, label: fileLabel(o), note: o.split(/[\\/]/).slice(0, -1).join("/") || undefined }))]}
          />
        </div>
        {/* plain, not primary: there can be one per missing file, and the header's Save is the screen's one primary action */}
        {!replaced && best && (
          <Button size="sm" disabled={busy || noRoute} data-tip={why ?? (caution ? `${best.tip ? `${best.tip} · ` : ""}${caution}` : best.tip)} onClick={() => download(best.from)} className="shrink-0">
            <DownloadIcon size={13} /> Download{best.bytes ? ` · ${size(best.bytes)}` : ""}
          </Button>
        )}
      </div>
      {!replaced && (
        <>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-ink-3">
            {f.url && <><a className={small} href={f.url} target="_blank" rel="noreferrer">URL in the workflow</a><span aria-hidden>·</span></>}
            {!f.url && f.source && (
              <>
                <span>{f.source.how === "notes" ? "author's notes:" : f.source.how === "creator" ? "same author on Civitai:" : "ComfyUI-Manager's list:"}</span>
                {f.source.page ? <a className={small} href={f.source.page} target="_blank" rel="noreferrer">{f.source.title}</a> : <span className="text-ink-2">{f.source.title}</span>}
                {!f.source.exact && <span className="text-warn-ink" data-tip={`Its file is ${f.source.file}, not this one: take it only if it is the same model.`}>other filename</span>}
                <span aria-hidden>·</span>
              </>
            )}
            {!f.url && !f.source && best && (
              <>
                {best.page ? <a className={small} href={best.page} target="_blank" rel="noreferrer" data-tip={best.tip}>{best.what}</a> : <span data-tip={best.tip}>{best.what}</span>}
                <span aria-hidden>·</span>
              </>
            )}
            {searchLinks(f.file).map((l, i) => (
              <span key={l.url} className="contents">
                {i > 0 && <span aria-hidden>·</span>}
                <a className={small} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>
              </span>
            ))}
            {lookups && (
              <>
                <span aria-hidden>·</span>
                <button type="button" onClick={search} disabled={find.isPending} className={cx(small, "disabled:opacity-60")} data-tip="Asks Hugging Face for a file of exactly this name, and Civitai for models with a close name.">
                  {find.isPending ? "Searching…" : "Search"}
                </button>
              </>
            )}
          </span>
          {start.isError && <span className="text-xs text-warn-ink">{start.error.message}</span>}
          {find.isError && <span className="text-xs text-warn-ink">{find.error.message}</span>}
          {find.data && !find.data.items.length && !find.data.exact.length && (
            <span className="text-xs text-ink-2">No match for that filename ({find.data.asked.join(", ")} {find.data.asked.length === 1 ? "was" : "were"} asked). It may be under another name.</span>
          )}
          {mine && <DownloadRow d={mine} />}
          {find.data && more > 0 && (
            <details className="group text-xs" open={!best}>
              <summary className="flex cursor-pointer list-none items-center gap-1 text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
                {best ? plural(more, "more match", "more matches") : `${plural(more, "match", "matches")}, none to download as is`}
              </summary>
              <div className="flex flex-col gap-1.5 pt-1.5">
                <span className="text-ink-2">
                  {find.data.exact.length > 0
                    ? moreCivitai.length ? "Other models with a close name, on Civitai (not needed when the exact file is the one):" : "Exact filename match on Hugging Face."
                    : civitaiSays(find.data)}
                  {find.data.silent.length > 0 && ` (${find.data.silent.join(" and ")} did not answer.)`}
                </span>
                {moreHf.map((h) => (
                  <HfMatch key={h.url} h={h}>
                    {fetching && !h.gated && (
                      <Button size="sm" disabled={busy || noRoute} data-tip={why} onClick={() => download({ url: h.url })} className="shrink-0"><DownloadIcon size={13} /> Download</Button>
                    )}
                  </HfMatch>
                ))}
                {moreCivitai.map((c) => (
                  <CivitaiMatch key={c.url} m={c} folder={folder}>
                    {fetching && c.versionId && (c.fits || c.exact) && !c.have && (
                      <Button size="sm" disabled={busy || noRoute} data-tip={why ?? civitaiTip(c, f.file)} onClick={() => download({ civitai: c.versionId!, ...civitaiExact(c) })} className="shrink-0">
                        <DownloadIcon size={13} /> {c.exact ? "Download" : "Download as this filename"}
                      </Button>
                    )}
                  </CivitaiMatch>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Where the workflow says the file comes from, in a sentence. */
function sourceSays(source: NonNullable<MissingFileOf["source"]>): string {
  const from = source.how === "notes" ? "The author's notes point to " : source.how === "creator" ? "The same author has it on Civitai: " : "A standard file, in ComfyUI-Manager's list: ";
  return `${from}${source.title}${source.exact ? ", the file itself." : `, whose file is ${source.file}, not this one: take it only if it is the same model.`}`;
}
