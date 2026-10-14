import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fileKey } from "@afflatus/core";
import { api } from "../api";
import { gb, plural, size } from "../format";
import { ViaChip } from "../modelFilesUi";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { Select } from "../Select";
import { Button, cx } from "../ui";
import { getOnPc, type FindTarget, type PickedFile } from "./store";

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
  const sayFailed = useSayFailed({ id: "find-models" });
  const bytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const estimate = files.length ? target.estimate?.(files) ?? null : null;
  const add = useMutation({ mutationFn: async () => target.add(files), onSuccess: onDone, onError: sayFailed("Not added") });
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
  // onto this PC: the usual downloads (Settings › Models shows them)
  const download = useMutation({
    mutationFn: () => getOnPc(files),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.downloads() });
      onDone();
    },
    onError: sayFailed("Not downloaded"),
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
          <div key={fileKey(f)} className="grid grid-cols-[minmax(0,1fr)_auto_64px_20px] items-center gap-2 border-b border-line/60 px-4 py-2 text-[12.5px]">
            <span className="flex min-w-0 flex-col">
              <span className="break-all">{f.file}</span>
              <span className="truncate text-xs text-ink-3">{f.folder} · {f.from}</span>
            </span>
            <ViaChip via={f.via} />
            <span className="text-right font-mono text-xs text-ink-2">{f.size ? size(f.size) : "–"}</span>
            <button type="button" aria-label={`Take ${f.file} off`} onClick={() => onRemove(f)} className="grid size-5 place-items-center rounded text-ink-3 hover:bg-hover hover:text-ink"><X size={12} /></button>
          </div>
        ))}
        {!files.length && <p className="px-4 py-6 text-center text-xs text-ink-3">Pick a model's files: its + on the card, open it, or drag it here.</p>}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 text-xs">
        <span className="flex justify-between"><span className="text-ink-3">to fetch</span><span className="font-mono">{gb(bytes)}</span></span>
        {estimate && <span className="flex justify-between gap-3"><span className="text-ink-3">time and price</span><span className="text-right font-mono">{estimate}</span></span>}
        <Button tone="primary" disabled={!files.length || add.isPending} onClick={() => add.mutate()} className="justify-center">{target.action}{files.length ? ` · ${files.length}` : ""}</Button>
        <span className="flex items-center gap-2">
          <span className="w-[150px]"><Select size="sm" label="Add to a Model set" value={toSet} placeholder="Add to a set…" onChange={(id) => { setToSet(id); intoSet.mutate(id); }} options={(sets.data?.items ?? []).map((s) => ({ value: s.id, label: s.name, note: plural(s.count, "file") }))} /></span>
          {!target.pc && <Button size="sm" tone="quiet" disabled={!files.length || download.isPending} onClick={() => download.mutate()}>Get on this PC</Button>}
        </span>
      </div>
    </div>
  );
}
