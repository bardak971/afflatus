import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, type FileVia, type SetSearch } from "./api";
import { gb, plural, size } from "./format";
import { useDebounced } from "./hooks";
import { queryKeys } from "./queryKeys";
import { Chip, cx, fieldClass } from "./ui";

/** Where a model file comes from onto a pod, in a word. */
export const VIA_SAID: Record<FileVia, string> = { hf: "HF", civitai: "Civitai", url: "web", upload: "this PC" };

/** A file's source as a chip: a site, this PC (an upload, in the warning tone), or none known. */
export function ViaChip({ via }: { via: FileVia | null | undefined }) {
  if (!via) return <Chip tone="warn" className="h-5 justify-self-start px-2 text-[11px]">no source</Chip>;
  return <Chip tone={via === "upload" ? "warn" : "neutral"} className="h-5 justify-self-start px-2 text-[11px]">{VIA_SAID[via]}</Chip>;
}

/** What a search finds and the user picks: a preset (its files), a family (its usual files), or one file of this PC. */
export type SearchPick =
  | { kind: "preset"; hit: SetSearch["presets"][number] }
  | { kind: "family"; hit: SetSearch["families"][number] }
  | { kind: "file"; hit: SetSearch["files"][number] };

/** "Add a preset, a family or any file": words typed, what matches listed, one picked. Deploy a GPU and a Model set's editor. */
export function ModelSearch({ onPick, presetNote = "" }: { onPick(pick: SearchPick): void; /** Said after a preset's file count ("its files follow it"). */ presetNote?: string }) {
  const [q, setQ] = useState("");
  const searched = useDebounced(q.trim(), 250, true, "");
  const found = useQuery({ queryKey: queryKeys.modelSets.search(searched), queryFn: ({ signal }) => api.searchModelSets(searched, { signal }), enabled: searched.length > 1, staleTime: 30_000 });
  const pick = (p: SearchPick) => {
    onPick(p);
    setQ("");
  };
  const row = "flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover";
  return (
    <div className="flex flex-col gap-1">
      <label className={cx(fieldClass, "flex h-8 items-center gap-2 px-2.5 text-[13px]")}>
        <Search size={13} className="shrink-0 text-ink-3" />
        <input aria-label="Add a preset, a family or any file" placeholder="Add a preset, a family or any file" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 grow bg-transparent outline-none placeholder:text-ink-3" />
      </label>
      {found.data && searched.length > 1 && (
        <div className="flex max-h-[200px] flex-col overflow-y-auto rounded-lg border border-line text-[13px]">
          {found.data.presets.map((p) => (
            <button key={p.id} type="button" onClick={() => pick({ kind: "preset", hit: p })} className={row}>
              <span className="min-w-0 grow truncate">{p.name}<span className="text-ink-3"> · preset · {plural(p.files.length, "file")}{presetNote ? ` · ${presetNote}` : ""}</span></span>
              {p.bytes > 0 && <span className="font-mono text-xs text-ink-3">{gb(p.bytes)}</span>}
            </button>
          ))}
          {found.data.families.map((f) => (
            <button key={f.id} type="button" onClick={() => pick({ kind: "family", hit: f })} className={row}>
              <span className="min-w-0 grow truncate">{f.name}<span className="text-ink-3"> · family · its usual {plural(f.files.length, "file")}</span></span>
            </button>
          ))}
          {found.data.files.map((f) => (
            <button key={`${f.folder}|${f.file}`} type="button" onClick={() => pick({ kind: "file", hit: f })} className={row}>
              <span className="min-w-0 grow truncate">{f.file}<span className="text-ink-3"> · {f.folder} · on this PC</span></span>
              {f.size && <span className="font-mono text-xs text-ink-3">{size(f.size)}</span>}
            </button>
          ))}
          {!found.data.presets.length && !found.data.families.length && !found.data.files.length && <span className="px-2.5 py-1.5 text-ink-3">Nothing matches “{searched}”.</span>}
        </div>
      )}
    </div>
  );
}
