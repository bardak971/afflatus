import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fuzzyFilter } from "@afflatus/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, type VolumeFile, type VolumeFilesView } from "../../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../../Dialog";
import { gb, plural, usd, when } from "../../format";
import { Keys } from "../../Keys";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, ErrorNote } from "../../ui";

/** A file no render used for this long, and not put there lately, is offered for deleting first. */
const UNUSED_DAYS = 30;
const DAY = 86_400_000;

/** No render used it for 30 days, nor was it put there in that time; one a render needs now never counts. */
function unused(f: VolumeFile, now: number): boolean {
  if (f.inUse) return false;
  const last = Math.max(f.usedAt ? Date.parse(f.usedAt) : 0, f.modified ? Date.parse(f.modified) : 0);
  return now - last >= UNUSED_DAYS * DAY;
}

const bytesOf = (files: readonly VolumeFile[]) => files.reduce((n, f) => n + (f.bytes ?? 0), 0);

/** Where what is shown comes from, in a few words, with its tone. */
function sourceSaid(v: VolumeFilesView): { text: string; tone: "good" | "plain" | "warn" } {
  if (v.source === "pod") return { text: `read now through ${v.readBy}`, tone: "good" };
  if (v.source === "s3") return { text: "read now through S3", tone: "good" };
  if (v.source === "kept") return { text: `as ${v.readBy} listed it ${v.readAt ? when(v.readAt) : ""}${v.files.some((f) => f.bytes === null) ? ", names only" : ""}`, tone: "plain" };
  return { text: "not read", tone: "warn" };
}

/**
 * A network volume's Files (Settings › Rented GPUs, its tile's Files, or a "volume is full" message's Open the volume): its
 * models folders on the left with the room each takes, the files of the one picked (or every match of the search) on the
 * right, and Delete for a selection. Read through RunPod's S3 API with no pod running; ComfyUI itself and the library's
 * media are not listed, nor ever deleted here.
 */
export function VolumeFiles({ volume, name, folder: askedFolder, pickUnused = false, onClose }: { volume: string; name: string; folder?: string; pickUnused?: boolean; onClose(): void }) {
  const files = useQuery({ queryKey: queryKeys.volumeFiles(volume), queryFn: ({ signal }) => api.volumeFiles(volume, { signal }), staleTime: 30_000, retry: false });
  const v = files.data;
  const list = useMemo(() => v?.files ?? [], [v]);
  const now = Date.now();
  const folders = useMemo(() => {
    const by = new Map<string, VolumeFile[]>();
    for (const f of list) by.set(f.folder, [...(by.get(f.folder) ?? []), f]);
    return [...by.entries()].map(([id, fs]) => ({ id, files: fs, bytes: bytesOf(fs) })).sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  }, [list]);
  const [folder, setFolder] = useState<string | null>(askedFolder ?? null);
  const shownFolder = folder && folders.some((f) => f.id === folder) ? folder : folders[0]?.id ?? null;
  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;
  const rows = useMemo(() => {
    // the name first: the match takes each letter where it first finds it, and "loras/" before a LoRA's name would take its l
    if (searching) return fuzzyFilter(list, q, (f) => `${f.name} ${f.sets.map((s) => s.name).join(" ")} ${f.folder}`);
    return (folders.find((f) => f.id === shownFolder)?.files ?? []).slice().sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name));
  }, [list, folders, shownFolder, q, searching]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const old = useMemo(() => list.filter((f) => unused(f, now)), [list, now]);
  // opened from a "volume is full" message: the files no render used lately, picked at once
  const pickedOnce = useRef(false);
  useEffect(() => {
    if (!pickUnused || pickedOnce.current || !v || !v.canDelete) return;
    pickedOnce.current = true;
    setPicked(new Set(old.map((f) => f.key)));
  }, [pickUnused, v, old]);
  const [confirm, setConfirm] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const canDelete = v?.canDelete ?? false;
  // sizes said: read through its pod or S3, or kept from such a read (a pod's listing by names has none)
  const sized = list.some((f) => f.bytes !== null);
  const selected = list.filter((f) => picked.has(f.key));

  const toggle = (f: VolumeFile, range: boolean) => {
    if (f.inUse || !canDelete) return;
    setPicked((was) => {
      const next = new Set(was);
      const from = range && anchor.current ? rows.findIndex((r) => r.key === anchor.current) : -1;
      const to = rows.findIndex((r) => r.key === f.key);
      if (from >= 0 && to >= 0) {
        const on = !was.has(f.key);
        for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) if (!r.inUse) (on ? next.add(r.key) : next.delete(r.key));
      } else if (next.has(f.key)) next.delete(f.key);
      else next.add(f.key);
      return next;
    });
    anchor.current = f.key;
  };
  const keys = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      search.current?.focus();
    } else if ((e.key === "Delete" || e.key === "Backspace") && !typing && selected.length) {
      e.preventDefault();
      setConfirm(true);
    } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && !typing && canDelete) {
      e.preventDefault();
      setPicked(new Set(rows.filter((r) => !r.inUse).map((r) => r.key)));
    }
  };

  const src = v ? sourceSaid(v) : null;
  const modelBytes = bytesOf(list);
  const size = (v?.volume.size ?? 0) * 2 ** 30;
  // the volume's whole use when its pod said it; else the models alone (ComfyUI's own files not counted)
  const used = v?.used ?? null;
  const install = used !== null ? Math.max(0, used - modelBytes) : null;
  return (
    <Dialog label={`Files of ${name}`} onClose={onClose} onEscape={() => !confirm && Boolean(q) && (setQ(""), true)} className="flex h-[min(720px,calc(100vh-48px))] w-full max-w-[1080px] flex-col overflow-hidden rounded-[18px] border border-line-strong bg-panel shadow-2xl shadow-shade/60 motion-safe:animate-[peek-rise_120ms_ease-out]">
      {/* the keys of the list (/, Del, Ctrl+A), wherever the focus is in it */}
      <div className="flex min-h-0 grow flex-col" onKeyDown={keys}>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-[18px] py-3">
          <span className="text-[15px] font-semibold">{name}</span>
          <span className="font-mono text-[11.5px] text-ink-3">{volume}</span>
          {v && <span className="inline-flex h-[22px] items-center rounded-md bg-raised px-2 text-[11.5px] text-ink-2">{v.volume.dataCenter}</span>}
          {src && <span data-tip={v?.why ?? undefined} className={cx("text-xs", src.tone === "good" ? "text-good" : src.tone === "warn" ? "text-warn-ink" : "text-ink-2")}>● {src.text}</span>}
          <span className="grow" />
          <label className="flex h-8 w-[250px] items-center gap-2 rounded-lg border border-line-strong bg-ground px-2.5 text-ink-3 focus-within:border-accent">
            <Search size={14} aria-hidden />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the volume" placeholder="Search all folders" className="min-w-0 grow bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3" />
            {q ? <button type="button" aria-label="Clear the search" onClick={() => setQ("")} className="text-ink-3 hover:text-ink"><X size={13} /></button> : <Keys keys="/" size="sm" />}
          </label>
          {v && v.source !== "none" && (
            <span className="text-xs text-ink-2" data-tip={used === null ? "The models alone: ComfyUI's own files on the volume are counted once a pod runs on it (its disk is read then)." : "All of the volume in use, as the pod on it read its disk."}>
              <b className="font-mono text-ink">{gb(used ?? modelBytes)}</b> of {v.volume.size} GB · <span className="font-mono">{usd(v.volume.perMonth)}</span>/month
            </span>
          )}
          <button type="button" aria-label="Read again" data-tip="Read again" onClick={() => void files.refetch()} disabled={files.isFetching} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50">
            <RefreshCw size={14} className={cx(files.isFetching && "animate-spin")} />
          </button>
          <button type="button" data-dialog-close="" aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
            <X size={15} />
          </button>
        </div>

        {files.isError && <div className="p-5"><ErrorNote>{files.error.message}</ErrorNote></div>}
        {files.isPending && <div className="p-5 text-xs text-ink-3">Reading the volume…</div>}
        {v && v.source === "none" && <div className="p-5 text-[13px] text-ink-2">{v.why}</div>}

        {v && v.source !== "none" && (
          <div className="flex min-h-0 grow">
            <div className="flex w-[250px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-ground/40 p-2.5">
              {searching && (
                <div className="flex justify-between rounded-[9px] bg-hover px-3 py-2 text-[13px] font-medium outline outline-line-strong">
                  <span>All folders</span><span className="font-mono text-xs text-ink-2">{rows.length} found</span>
                </div>
              )}
              {folders.map((f) => {
                const on = !searching && f.id === shownFolder;
                const found = searching ? rows.filter((r) => r.folder === f.id).length : null;
                return (
                  <button key={f.id} type="button" onClick={() => { setQ(""); setFolder(f.id); }} aria-pressed={on} className={cx("flex flex-col gap-1.5 rounded-[9px] px-3 py-2 text-left", on ? "bg-hover outline outline-line-strong" : "hover:bg-hover/60", found === 0 && "opacity-45")}>
                    <span className="flex justify-between gap-2 text-[13px]">
                      <span className={cx("truncate", on && "font-medium")}>{f.id}</span>
                      <span className="shrink-0 font-mono text-xs text-ink-2">{found !== null ? found : sized ? gb(f.bytes) : f.files.length}</span>
                    </span>
                    {sized && (
                      <span className="flex items-center gap-2">
                        <span className="h-1 grow overflow-hidden rounded-sm bg-line"><span className={cx("block h-1", on ? "bg-accent" : "bg-ink-3")} style={{ width: `${size ? Math.max(1, (f.bytes / size) * 100) : 0}%` }} /></span>
                        <span className="w-[52px] text-right text-[11.5px] text-ink-3">{plural(f.files.length, "file")}</span>
                      </span>
                    )}
                  </button>
                );
              })}
              <span className="grow" />
              <div className="mt-2 rounded-[9px] border border-dashed border-line-strong px-3 py-2.5 text-xs text-ink-3">
                <div className="flex justify-between"><span>ComfyUI install</span><span className="font-mono">{install !== null ? gb(install) : "–"}</span></div>
                <div className="mt-1 text-[11.5px]">{install !== null ? "Python, node packs, outputs. Never opened or deleted here." : "Counted once a pod runs on the volume. Never opened or deleted here."}</div>
              </div>
            </div>

            <div className="flex min-w-0 grow flex-col">
              <div className="flex items-center gap-2.5 border-b border-line bg-raised/50 px-3.5 py-2.5 text-[13px]">
                <span className="font-semibold">{searching ? `${plural(rows.length, "file")} match “${q.trim()}”` : shownFolder}</span>
                <span className="text-ink-3">{searching ? "best match first" : plural(rows.length, "file")}{sized && ` · ${gb(bytesOf(rows))}`}</span>
              </div>
              <div role="row" className="grid grid-cols-[24px_minmax(0,1fr)_84px_104px_150px_56px] gap-2.5 border-b border-line px-3.5 py-2 text-[11px] tracking-wide text-ink-3 uppercase">
                <span /><span>Name</span><span className="text-right">Size</span><span>Last used</span><span>Sets</span><span className="text-right">This PC</span>
              </div>
              <div role="grid" aria-label={`Files of ${name}`} aria-multiselectable className="min-h-0 grow overflow-y-auto">
                {rows.map((f) => {
                  const on = picked.has(f.key);
                  const old = unused(f, now);
                  return (
                    <button
                      key={f.key}
                      type="button"
                      role="row"
                      aria-selected={on}
                      disabled={!canDelete}
                      onClick={(e) => toggle(f, e.shiftKey)}
                      data-tip={f.inUse ? "A render running on the volume needs it now: it cannot be deleted" : undefined}
                      className={cx("grid w-full grid-cols-[24px_minmax(0,1fr)_84px_104px_150px_56px] items-center gap-2.5 border-b border-line/60 px-3.5 py-2 text-left text-[12.5px] disabled:cursor-default", on ? "bg-accent-wash" : "hover:bg-hover/50", f.inUse && "opacity-70")}
                    >
                      <span aria-hidden className={cx("grid size-3.5 place-items-center rounded-[4px] border-[1.5px]", on ? "border-accent bg-accent text-accent-ink" : "border-ink-3", (!canDelete || f.inUse) && "opacity-40")}>{on && <Check size={10} strokeWidth={3} />}</span>
                      <span className="truncate font-mono text-xs" data-tip={`${f.folder}/${f.name}`}>{searching && <span className="text-ink-3">{f.folder}/</span>}{f.name}</span>
                      <span className="text-right font-mono">{f.bytes !== null ? gb(f.bytes) : "–"}</span>
                      <span className={cx(f.inUse ? "text-good" : old ? "text-warn-ink" : "text-ink-2")}>{f.inUse ? "rendering now" : f.usedAt ? when(f.usedAt) : "never here"}</span>
                      <span className="flex gap-1 overflow-hidden">{f.sets.slice(0, 2).map((s) => <span key={s.id} className="inline-flex h-5 shrink-0 items-center rounded-md bg-raised px-1.5 text-[11px] text-ink-2">{s.name}</span>)}{f.sets.length > 2 && <span className="text-[11px] text-ink-3">+{f.sets.length - 2}</span>}</span>
                      <span className="text-right text-good">{f.here ? "✓" : ""}</span>
                    </button>
                  );
                })}
                {!rows.length && <div className="p-5 text-xs text-ink-3">{searching ? "Nothing matches." : "This folder is empty."}</div>}
              </div>
            </div>
          </div>
        )}

        {v && v.source !== "none" && (
          <div className={cx("flex flex-wrap items-center gap-2.5 border-t border-line px-[18px] py-2.5 text-[12.5px]", selected.length ? "bg-accent-wash" : "text-ink-2")}>
            {selected.length ? (
              <>
                <b>{plural(selected.length, "file")} selected · {gb(bytesOf(selected))}</b>
                <Button size="sm" tone="danger" onClick={() => setConfirm(true)}><Trash2 size={13} /> Delete <Keys keys="Del" size="sm" /></Button>
                <Button size="sm" tone="quiet" onClick={() => setPicked(new Set())}>Clear</Button>
              </>
            ) : !v.canDelete ? (
              <span>{v.why}</span>
            ) : old.length ? (
              <>
                <span>{plural(old.length, "file")} no render used in {UNUSED_DAYS} days {old.length === 1 ? "holds" : "hold"} <b className="text-ink">{gb(bytesOf(old))}</b>.</span>
                <Button size="sm" onClick={() => setPicked(new Set(old.map((f) => f.key)))}>Select them</Button>
              </>
            ) : (
              <span>No file has gone {UNUSED_DAYS} days without a render or a fetch.</span>
            )}
            <span className="grow" />
            {canDelete && !selected.length && <span className="text-ink-3">Click to select, Shift for a range, Del deletes.</span>}
          </div>
        )}
      </div>
      {confirm && v && <DeleteFiles view={v} files={selected} onDone={(gone) => { setConfirm(false); setPicked((was) => new Set([...was].filter((k) => !gone.includes(k)))); }} onClose={() => setConfirm(false)} />}
    </Dialog>
  );
}

/**
 * Delete a selection, said first: gone for good (S3 keeps no bin), the room it frees, the bill unchanged (a volume bills its
 * size), the sets then lacking files on it, the files this PC has no copy of, and the pod on it reading its folders again.
 */
function DeleteFiles({ view, files, onDone, onClose }: { view: VolumeFilesView; files: VolumeFile[]; onDone(gone: string[]): void; onClose(): void }) {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ href: "/settings/rented", go: "Open Rented GPUs" });
  const del = useMutation({
    mutationFn: () => api.deleteVolumeFiles(view.volume.id, files.map((f) => f.key)),
    onSuccess: (r) => {
      for (const queryKey of [queryKeys.volumeFiles(view.volume.id), queryKeys.runpodVolumes()]) void client.invalidateQueries({ queryKey });
      if (r.kept.length) sayFailed(`${plural(r.kept.length, "file")} not deleted`)(new Error(r.kept.map((k) => `${k.key.split("/").pop()}: ${k.why}`).join("\n")));
      onDone(r.deleted);
    },
  });
  const bytes = bytesOf(files);
  const sets = [...new Map(files.flatMap((f) => f.sets).map((s) => [s.id, s])).values()];
  const only = files.filter((f) => !f.here);
  const used = view.used ?? null;
  return (
    <Dialog label="Delete files of a volume" onClose={onClose} z="z-50" className={DIALOG.replace("max-w-md", "max-w-[600px]")}>
      <DialogHead icon={<Trash2 size={16} />} tone="warn" title={`Delete ${plural(files.length, "file")} · ${gb(bytes)}?`} sub={`From ${view.volume.name}`} onClose={onClose} />
      <ul className="m-0 flex flex-col gap-1.5 pl-4 text-[12.5px] text-ink-2">
        <li>Gone from the volume for good: S3 keeps no bin. Frees <b className="font-mono text-ink">{gb(bytes)}</b>{used !== null && <> ({gb(Math.max(0, view.volume.size * 2 ** 30 - used + bytes))} free after)</>}. The bill stays <span className="font-mono">{usd(view.volume.perMonth)}</span>/month: a volume is billed by its size.</li>
        {sets.length > 0 && <li>{sets.map((s) => s.name).join(", ")} then {sets.length === 1 ? "lacks" : "lack"} {files.length === 1 ? "it" : "them"} here: a pod on this volume fetches {files.length === 1 ? "it" : "them"} again when a render needs {files.length === 1 ? "it" : "them"}.</li>}
        {only.length > 0 && <li>{only.length === files.length ? (files.length === 1 ? "This PC has no copy of it" : "This PC has a copy of none of them") : `This PC has no copy of ${only.length} of them`}: {only.slice(0, 3).map((f) => f.name.split("/").pop()).join(", ")}{only.length > 3 ? "…" : "."}</li>}
        {view.volume.usedBy && <li>{view.volume.usedBy.name}, running on it, reads its folders again.</li>}
      </ul>
      {del.isError && <ErrorNote>{del.error.message}</ErrorNote>}
      <DialogFoot>
        <Button tone="quiet" onClick={onClose}>Keep them <Keys keys="Esc" size="sm" /></Button>
        <Button tone="danger" onClick={() => del.mutate()} disabled={del.isPending}><Trash2 size={13} /> Delete {plural(files.length, "file")}</Button>
      </DialogFoot>
    </Dialog>
  );
}
