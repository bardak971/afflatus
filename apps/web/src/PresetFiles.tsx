import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download as DownloadIcon, ExternalLink, ScrollText } from "lucide-react";
import { Link } from "wouter";
import { api, type PresetDef, type PresetFileView, type PresetFilesView } from "./api";
import { useSettings } from "./data";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { fileLabel, gb, plural } from "./format";
import { DownloadRow, GetFile, useDownloads } from "./GetFile";
import { Keys } from "./Keys";
import { Button, cx, ErrorNote } from "./ui";
import { queryKeys } from "./queryKeys";

/**
 * The model files a preset is made for: which ComfyUI has, a Download under each missing one, one button
 * for all the required ones, and the licence they come under, accepted once. Shown on a preset in the
 * Prompt kit; the same facts give Studio's form its "this file is missing" line.
 */

export const usePresetFiles = () => useQuery({ queryKey: queryKeys.presetFiles(), queryFn: api.presetFiles, staleTime: 30_000 });

/** Every file any preset names, by folder and name: where a missing file can be had. */
function presetFileIndex(data: { items: PresetFilesView[] } | undefined): Map<string, PresetFileView> {
  const map = new Map<string, PresetFileView>();
  for (const p of data?.items ?? []) for (const f of p.files) map.set(`${f.folder}:${(f.file.split(/[\\/]/).pop() ?? f.file).toLowerCase()}`, f);
  return map;
}
const fileKey = (folder: string, file: string) => `${folder}:${(file.split(/[\\/]/).pop() ?? file).toLowerCase()}`;

const KEYS = [queryKeys.presetFiles(), queryKeys.setup(), queryKeys.downloads(), queryKeys.settings()];

/**
 * A preset's files and the one fetch of the required missing ones: what is missing, its size, whether the licence is
 * accepted, and `go` (asks the licence first when it is not). Shared by the files block and, on a shipped preset, the
 * page's head, whose main button it is while a file is missing.
 */
export function usePresetFetch(id: string, def: PresetDef) {
  const all = usePresetFiles();
  const settings = useSettings();
  const client = useQueryClient();
  const [licence, setLicence] = useState(false);
  const [got, setGot] = useState<{ started: number; failed: Array<{ file: string; error: string }>; skipped: number } | null>(null);
  const status = all.data?.items.find((p) => p.id === id);
  const files = status?.files ?? (def.files ?? []).map((f) => ({ ...f, have: false }));
  const fetching = Boolean(settings.data?.downloadModels);
  const fetchAll = useMutation({
    // the button is there whether downloads are on or not: pressed, it turns them on (it says so) and fetches
    mutationFn: async (accept?: boolean) => {
      if (!fetching) await api.saveSettings({ downloadModels: true });
      return api.getPresetFiles(id, accept ? { accept } : {});
    },
    onSuccess: (r) => {
      setGot({ started: r.started.length, failed: r.failed, skipped: r.skipped });
      void Promise.all(KEYS.map((k) => client.invalidateQueries({ queryKey: k })));
    },
  });
  const missing = files.filter((f) => !f.have);
  const fetchable = missing.filter((f) => (f.url || f.civitai) && !f.optional);
  const needsKey = fetchable.some((f) => f.civitai) && !settings.data?.hasCivitaiKey;
  const bytes = fetchable.reduce((n, f) => n + (f.size ?? 0), 0);
  const accepted = status?.accepted ?? !def.licence;
  const go = () => (def.licence && !accepted ? setLicence(true) : fetchAll.mutate(undefined));
  return { status, files, missing, fetchable, needsKey, bytes, accepted, fetching, go, fetchAll, got, licence, setLicence };
}
export type PresetFetch = ReturnType<typeof usePresetFetch>;

/**
 * `fetch`: the page's own (a shipped preset's head holds the Get button); `inHead`: that button and the licence line are the
 * page's, not drawn here.
 */
export function PresetFiles({ id, def, fetch, inHead = false }: { id: string; def: PresetDef; fetch?: PresetFetch; inHead?: boolean }) {
  const own = usePresetFetch(id, def);
  const downloads = useDownloads();
  const { status, files, fetchable, needsKey, bytes, accepted, fetching, go, fetchAll, got, licence, setLicence } = fetch ?? own;
  if (!files.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-ink-2">Model files</span>
      <div className="flex flex-col divide-y divide-line rounded-md border border-line bg-panel">
        {files.map((x) => {
          const page = x.civitai?.page ?? x.page;
          return (
            <div key={`${x.folder}:${x.file}`} className="flex flex-col gap-1 px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[11px]" data-tip={x.file}>{x.file}</span>
                    {x.optional && <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] font-bold tracking-wide text-ink-3 uppercase">optional</span>}
                  </span>
                  {x.note && <span className="text-ink-3">{x.note}</span>}
                </span>
                <span className="grow" />
                <span className="shrink-0 text-ink-3">models/{x.folder}{x.size ? ` · ${gb(x.size)}` : ""}</span>
                <span className={cx("shrink-0 font-semibold", x.have ? "text-good" : "text-warn-ink")}>{x.have ? "in ComfyUI" : "missing"}</span>
                {page && <a href={page} target="_blank" rel="noreferrer" aria-label="Its page" data-tip="Its page" className="shrink-0 text-ink-2 hover:text-ink"><ExternalLink size={12} /></a>}
              </div>
              {!x.have && fetching && accepted && (x.url || x.civitai) && (
                <GetFile file={x.file} folder={x.folder} url={x.url} civitai={x.civitai?.version} pick={x.civitai?.pick} hints={[]} />
              )}
            </div>
          );
        })}
      </div>
      {status?.needs && status.needs.missing.length > 0 && (
        <div className="text-xs text-warn-ink">
          {status.needs.name} itself is missing {status.needs.missing.join(", ").toLowerCase()}: <Link href="/settings/models" className="font-semibold underline">Settings → Models</Link> has them.
        </div>
      )}
      {def.licence && !inHead && (
        <div className="text-xs text-ink-2">
          Licence: {def.licence.url ? <a href={def.licence.url} target="_blank" rel="noreferrer" className="font-semibold underline">{def.licence.name}</a> : <span className="font-semibold">{def.licence.name}</span>}
          {accepted ? " · accepted" : " · to accept before the files are fetched"}
          {def.licence.note && !accepted ? <span className="block text-warn-ink">{def.licence.note}</span> : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {fetchable.length > 0 && !inHead && (
          <Button size="sm" tone="primary" onClick={go} disabled={fetchAll.isPending} className="flex items-center gap-1.5">
            <DownloadIcon size={13} /> Get the {plural(fetchable.length, "missing file")}{bytes ? ` (${gb(bytes)})` : ""}
          </Button>
        )}
        {/* most Civitai files are refused without a key: said before the click, with where the key goes */}
        {fetchable.length > 0 && needsKey && <span className="text-xs text-warn-ink">Most Civitai files need your Civitai API key (free with an account): add it in <Link href="/settings/models" className="font-semibold underline">Settings → Models</Link>.</span>}
        {fetchable.length > 0 && !needsKey && !fetching && <span className="text-xs text-ink-2">This also turns on "Download missing models into ComfyUI" (<Link href="/settings/models" className="font-semibold underline">Settings → Models</Link>).</span>}
      </div>
      {got && (
        <div className="text-xs text-ink-2">
          {got.started > 0 && <div>{plural(got.started, "download")} started.</div>}
          {got.failed.map((x) => <div key={x.file} className="text-warn-ink">{fileLabel(x.file)}: {x.error}</div>)}
        </div>
      )}
      {fetchAll.isError && <ErrorNote>{fetchAll.error.message}</ErrorNote>}
      {downloads.data?.items.filter((d) => files.some((f) => fileKey(f.folder, f.file) === fileKey(d.folder, d.file)) && d.status !== "done").map((d) => <DownloadRow key={d.id} d={d} named />)}
      {licence && def.licence && (
        <Dialog label="Licence of the preset's files" onClose={() => setLicence(false)} className={cx(DIALOG, "max-w-[520px]")}>
            <DialogHead icon={<ScrollText size={16} />} title="Before the files are fetched" sub={`Licence of the preset's files · ${def.licence.name}`} onClose={() => setLicence(false)} />
            <div className="text-ink-2">
              They come under the {def.licence.url ? <a href={def.licence.url} target="_blank" rel="noreferrer" className="font-semibold underline">{def.licence.name}</a> : <span className="font-semibold">{def.licence.name}</span>}.
              {def.licence.note ? ` ${def.licence.note}` : ""}
            </div>
            <DialogFoot info={<span data-tip="Accepting it is between you and the files' authors; Afflatus only remembers that you did, and asks once.">Between you and the files' authors · asked once</span>}>
              <Button tone="quiet" onClick={() => setLicence(false)}>Not now <Keys keys="Esc" size="sm" /></Button>
              <Button tone="primary" onClick={() => { setLicence(false); fetchAll.mutate(true); }}>I accept, fetch the files</Button>
            </DialogFoot>
        </Dialog>
      )}
    </div>
  );
}

/** Under a form's Model field: the file it names is not in ComfyUI, and where it is had when a preset knows. */
export function MissingModel({ folder, file }: { folder: string; file: string }) {
  const all = usePresetFiles();
  const found = presetFileIndex(all.data).get(fileKey(folder, file));
  return (
    <div className="flex flex-col gap-1 text-xs text-warn-ink">
      <span>ComfyUI does not have <span className="font-semibold">{fileLabel(file)}</span> in models/{folder}.{found ? " A preset says where it is had:" : ""}</span>
      {found && <GetFile file={found.file} folder={found.folder} url={found.url} civitai={found.civitai?.version} pick={found.civitai?.pick} hints={[]} />}
    </div>
  );
}
