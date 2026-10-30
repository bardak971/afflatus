import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileKey } from "@afflatus/core";
import { api } from "../api";
import { gb, plural, size } from "../format";
import { ViaChip } from "../modelFilesUi";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { Select } from "../Select";
import { Button, CloseButton, cx } from "../ui";
import { FileState, GoesTo } from "../DownloadsLine";
import { useDownloads } from "../useGetFile";
import { getOnPc, refusedSaid, type FindTarget, type PickedFile } from "./store";

/**
 * Picked: what goes where the browser was opened for, each file with where it comes from and its size, what they come to
 * (and take, and cost, when the place knows), and its button. Also into a Model set, or onto this PC, from here.
 */
export function Tray({ files, target, onRemove, onClear, onDone, dropping, onOver, onDrop }: {
  files: PickedFile[];
  target: FindTarget;
  onRemove(f: PickedFile): void;
  onClear(): void;
  onDone(): void;
  /** A card is dragged over: the tray says it takes it. */
  dropping: boolean;
  onOver(over: boolean): void;
  onDrop(e: React.DragEvent): void;
}) {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "find-models", here: true });
  // onto this PC, each file's download says how it goes in its row (In line · 3rd, Downloading, Here): a file coming or
  // here already is not asked for twice, and Picked stays open on them (card #60)
  const downloads = useDownloads().data?.items ?? [];
  const mine = (f: PickedFile) => downloads.find((d) => d.file === f.file && d.folder === f.folder && !d.machine && d.status !== "error" && d.status !== "stopped");
  const toGet = target.pc ? files.filter((f) => !mine(f)) : files;
  const bytes = toGet.reduce((n, f) => n + (f.size ?? 0), 0);
  const estimate = toGet.length ? target.estimate?.(toGet) ?? null : null;
  const add = useMutation({ mutationFn: async () => target.add(toGet), onSuccess: () => (target.pc ? void client.invalidateQueries({ queryKey: queryKeys.downloads() }) : onDone()), onError: sayFailed(target.pc ? "Not downloaded" : "Not added") });
  // the files into a Model set as its own files (the set saved as it is, plus these)
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }), staleTime: 30_000 });
  const [toSet, setToSet] = useState("");
  const intoSet = useMutation({
    mutationFn: async (id: string) => {
      const set = sets.data!.items.find((x) => x.id === id)!;
      const own = set.files.filter((f) => !files.some((p) => fileKey(p) === fileKey(f)));
      return api.saveModelSet(id, { name: set.name, presets: set.presets.map((p) => p.id), off: set.off, files: [...own, ...files.map(({ file, folder, url, civitai, size: s }) => ({ file, folder, ...(url ? { url } : {}), ...(civitai ? { civitai } : {}), ...(s ? { size: s } : {}) }))] });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.modelSets.all() });
      onDone();
    },
    onError: sayFailed("Not added to the set"),
  });
  // onto this PC: the usual downloads (Settings › Models shows them). The ones started leave Picked even when others
  // were refused, so that a second try does not start them again; the refused stay, named in the banner.
  const download = useMutation({
    mutationFn: () => getOnPc(files),
    onSuccess: (refused) => {
      if (!refused.length) return onDone();
      for (const f of files) if (!refused.some((r) => r.file === f)) onRemove(f);
      sayFailed(`${plural(refused.length, "file")} not downloaded`)(new Error(refusedSaid(refused)));
    },
    onError: sayFailed("Not downloaded"),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.downloads() }),
  });
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("application/x-afflatus-card")) return;
        e.preventDefault();
        onOver(true);
      }}
      onDragLeave={() => onOver(false)}
      onDrop={onDrop}
      className={cx("flex min-h-0 flex-col border-l border-line transition-colors", dropping && "bg-accent-wash")}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-semibold">Picked</span>
        <span className="text-xs text-ink-3">{files.length ? plural(files.length, "file") : "drop a card here"}</span>
        <span className="grow" />
        {files.length > 0 && <button type="button" onClick={onClear} className="text-xs text-ink-3 hover:text-ink">clear</button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.map((f) => (
          <div key={fileKey(f)} className="grid grid-cols-[minmax(0,1fr)_auto_64px_24px] items-center gap-2 border-b border-line/60 px-4 py-2 text-body">
            <span className="flex min-w-0 flex-col">
              <span className="break-all">{f.file}</span>
              <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-3">{f.folder} · {f.from}{target.pc && !mine(f) && <GoesTo folder={f.folder} />}</span>
            </span>
            {target.pc && mine(f) ? <FileState d={mine(f)} /> : <ViaChip via={f.via} />}
            <span className="text-right font-mono text-xs text-ink-2">{f.size ? size(f.size) : "–"}</span>
            <CloseButton size={24} label={`Take ${f.file} off`} onClose={() => onRemove(f)} />
          </div>
        ))}
        {!files.length && <p className="px-4 py-6 text-center text-xs text-ink-3">Pick a model's files: its + on the card, open it, or drag it here.</p>}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 text-xs">
        <span className="flex justify-between"><span className="text-ink-3">to fetch</span><span className="font-mono">{gb(bytes)}</span></span>
        {estimate && <span className="flex justify-between gap-3"><span className="text-ink-3">time and price</span><span className="text-right font-mono">{estimate}</span></span>}
        <Button tone="primary" disabled={!toGet.length || add.isPending} onClick={() => add.mutate()} className="justify-center">{target.action}{toGet.length ? ` · ${toGet.length}` : ""}</Button>
        <span className="flex items-center gap-2">
          <span className="w-[150px]"><Select size="sm" label="Add to a Model set" value={toSet} placeholder="Add to a set…" disabled={!files.length || intoSet.isPending} onChange={(id) => { setToSet(id); intoSet.mutate(id); }} options={(sets.data?.items ?? []).map((s) => ({ value: s.id, label: s.name, note: plural(s.count, "file") }))} /></span>
          {!target.pc && <Button size="sm" tone="quiet" disabled={!files.length || download.isPending} onClick={() => download.mutate()}>Get on this PC</Button>}
        </span>
      </div>
    </div>
  );
}
