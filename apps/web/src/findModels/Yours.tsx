import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search } from "lucide-react";
import { fileKey } from "@afflatus/core";
import { api, type DeployFile } from "../api";
import { plural, size } from "../format";
import { useSettled } from "../hooks";
import { filesOfPick, ViaChip } from "../modelFilesUi";
import { queryKeys } from "../queryKeys";
import { cx, ErrorNote, fieldClass } from "../ui";
import type { PickedFile } from "./store";

/** One of the user's own: a preset or a family's usual files, as a card; + picks all its files. */
function OwnCard({ kind, name, files, picked, onPick }: { kind: string; name: string; files: DeployFile[]; picked: Set<string>; onPick(): void }) {
  const all = files.length > 0 && files.every((f) => picked.has(fileKey(f)));
  const bytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  return (
    <div className={cx("group flex min-w-0 flex-col gap-2 rounded-xl border bg-panel p-3", all ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "border-line")}>
      <span className="flex items-start gap-2">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised font-mono text-lg text-ink-3">{name.slice(0, 1).toUpperCase()}</span>
        <span className="flex min-w-0 grow flex-col">
          <span className="line-clamp-2 text-[13.5px] font-semibold break-words">{name}</span>
          <span className="text-xs text-ink-3">{kind} · {plural(files.length, "file")}{bytes ? ` · ${size(bytes)}` : ""}</span>
        </span>
        <button type="button" aria-label={`Pick ${name}'s files`} onClick={onPick} disabled={all || !files.length} className={cx("grid size-7 shrink-0 place-items-center rounded-lg", all ? "bg-accent-wash text-accent" : "bg-accent text-accent-ink hover:brightness-110")}>
          {all ? <Check size={14} /> : <Plus size={15} />}
        </button>
      </span>
      <span className="flex flex-col gap-1">
        {files.slice(0, 4).map((f) => (
          <span key={fileKey(f)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="break-all text-ink-2">{f.file.split(/[\\/]/).pop()}</span>
            <ViaChip via={f.via} />
          </span>
        ))}
        {files.length > 4 && <span className="text-xs text-ink-3">and {files.length - 4} more</span>}
      </span>
    </div>
  );
}

/**
 * Find models › Yours: the user's presets and model families' usual files as cards from the start, and this PC's model
 * files as rows once words are typed; matched as every list of the app (fuzzy).
 */
export function Yours({ words, onWords, picked, onPick }: { words: string; onWords(w: string): void; picked: Set<string>; onPick(files: PickedFile[]): void }) {
  const q = useSettled(words, 300);
  const found = useQuery({ queryKey: [...queryKeys.modelSets.search(q), "many"], queryFn: ({ signal }) => api.searchModelSets(q, { signal, many: true }), staleTime: 30_000 });
  const d = found.data;
  const pick = (from: string, files: DeployFile[]) => onPick(files.map((f) => ({ ...f, from })));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-4 py-2.5">
        <label className={cx(fieldClass, "flex h-9 items-center gap-2 px-3")}>
          <Search size={14} className="text-ink-3" />
          <input autoFocus value={words} onChange={(e) => onWords(e.target.value)} placeholder="Your presets, your families, this PC's files" className="min-w-0 grow bg-transparent outline-none placeholder:text-ink-3" />
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {found.isError && <ErrorNote>{found.error.message}</ErrorNote>}
        {d && d.presets.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Presets</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {d.presets.map((p) => <OwnCard key={p.id} kind="Preset" name={p.name} files={filesOfPick({ kind: "preset", hit: p })} picked={picked} onPick={() => pick(p.name, filesOfPick({ kind: "preset", hit: p }))} />)}
            </div>
          </section>
        )}
        {d && d.families.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Model families · their usual files</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {d.families.map((f) => <OwnCard key={f.id} kind="Family" name={f.name} files={filesOfPick({ kind: "family", hit: f })} picked={picked} onPick={() => pick(f.name, filesOfPick({ kind: "family", hit: f }))} />)}
            </div>
          </section>
        )}
        {d && d.files.length > 0 && (
          <section className="flex flex-col gap-1">
            <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">On this PC</span>
            {d.files.map((f) => {
              const on = picked.has(fileKey(f));
              return (
                <div key={fileKey(f)} className="grid grid-cols-[minmax(0,1fr)_auto_64px_28px] items-center gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover">
                  <span className="min-w-0 break-all">{f.file}<span className="text-ink-3"> · {f.folder}</span></span>
                  <ViaChip via={f.via} />
                  <span className="text-right font-mono text-xs text-ink-3">{f.size ? size(f.size) : "–"}</span>
                  <button type="button" aria-label={`Pick ${f.file}`} disabled={on} onClick={() => pick("this PC", filesOfPick({ kind: "file", hit: f }))} className={cx("grid size-6 place-items-center rounded-md", on ? "text-accent" : "text-ink-2 hover:bg-raised hover:text-ink")}>{on ? <Check size={13} /> : <Plus size={14} />}</button>
                </div>
              );
            })}
          </section>
        )}
        {d && !words.trim() && <p className="text-xs text-ink-3">Type to find a file of this PC's ComfyUI too.</p>}
        {d && words.trim() && !d.presets.length && !d.families.length && !d.files.length && <p className="py-10 text-center text-sm text-ink-2">Nothing of yours matches. Civitai and Hugging Face have more.</p>}
      </div>
    </div>
  );
}
