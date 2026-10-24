import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Lock } from "lucide-react";
import { api, type BrowseCard, type BrowseFile } from "../api";
import { compact, plural, shortDate, size } from "../format";
import { queryKeys } from "../queryKeys";
import { Select } from "../Select";
import { Button, Checkbox, Chip, CloseButton, cx, ErrorNote } from "../ui";
import { pickedOf, useFolders, type PickedFile } from "./store";

/** What the user has of a file, in a few words: "on this PC", "in set Video". */
const haveSaid = (f: BrowseFile) => f.have.map((h) => (h.kind === "pc" ? "on this PC" : `in set ${h.name}`)).join(" · ");

/**
 * A model opened: its versions (Civitai) or its repository's files (Hugging Face, read on opening), each file with its
 * size, what tells it apart, its folder (the guess, changed here) and what the user has of it; its trigger words and
 * licence. Pick takes the ticked files to Picked.
 */
export function Opened({ card, picked, onPick, onClose }: { card: BrowseCard; picked: Set<string>; onPick(files: PickedFile[]): void; onClose(): void }) {
  const repo = useQuery({ queryKey: queryKeys.browse.repo(card.id), queryFn: ({ signal }) => api.browseRepoFiles(card.id, { signal }), enabled: card.site === "huggingface" && !card.versions.length, staleTime: 10 * 60_000, retry: false });
  const versions = card.versions.length ? card.versions : repo.data ? [{ id: "main", name: "main", base: "", publishedAt: null, trainedWords: [], files: repo.data.files }] : [];
  const [versionId, setVersionId] = useState<string | null>(null);
  const version = versions.find((v) => v.id === versionId) ?? versions[0];
  // the files ticked, by name; a version of one file starts with it ticked
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const on = ticked ?? new Set(version?.files.length === 1 ? [version.files[0]!.name] : []);
  const [folders, setFolders] = useState<Record<string, string>>({});
  const folderOf = (f: BrowseFile) => folders[f.name] ?? f.folder ?? "";
  const chosen = (version?.files ?? []).filter((f) => on.has(f.name));
  const lacksFolder = chosen.some((f) => !folderOf(f));
  const folderList = useFolders();
  // a guess ComfyUI does not list (a custom node not installed yet) stays a choice
  const foldersOf = (f: BrowseFile) => (folderOf(f) && !folderList.includes(folderOf(f)) ? [folderOf(f), ...folderList] : folderList);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* closed, the results are back as they were */}
      <div className="flex items-center justify-end gap-2">
        <a href={card.page} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink">{card.site === "civitai" ? "On Civitai" : "On Hugging Face"} <ExternalLink size={12} /></a>
        <CloseButton size={28} keys="Esc" onClose={onClose} />
      </div>
      <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-5">
        <div className="aspect-[3/4] overflow-hidden rounded-xl border border-line bg-raised">
          {card.thumb ? <img src={card.thumb} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center font-mono text-5xl text-ink-3">{card.creator.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold">{card.name}</span>
            {(card.type || card.fits || card.base) && <Chip>{[card.type, card.fits ?? card.base].filter(Boolean).join(" · ")}</Chip>}
            {card.gated && <Chip tone="warn"><Lock size={11} /> gated: accept its terms on Hugging Face</Chip>}
          </span>
          <span className="text-xs text-ink-3">by {card.creator}{card.downloads ? ` · ${compact(card.downloads)} downloads` : ""}{card.updatedAt ? ` · updated ${shortDate(card.updatedAt)}` : ""}</span>
          {versions.length > 1 && (
            <span className="flex flex-wrap gap-1.5">
              {versions.map((v) => (
                <button key={v.id} type="button" onClick={() => { setVersionId(v.id); setTicked(null); }} className={cx("rounded-lg border px-2.5 py-1 text-xs font-semibold", v.id === version?.id ? "border-accent bg-accent-wash text-accent" : "border-line text-ink-2 hover:bg-hover")}>
                  {v.name}{v.base && v.base !== card.base ? ` · ${v.base}` : ""}
                </button>
              ))}
            </span>
          )}
          {repo.isPending && card.site === "huggingface" && !card.versions.length && <span className="text-xs text-ink-3">Reading its files…</span>}
          {repo.isError && <ErrorNote>{repo.error.message}</ErrorNote>}
          {version && (
            <div className="flex flex-col rounded-xl border border-line">
              {version.files.map((f) => (
                <div key={f.name} className="grid grid-cols-[minmax(0,1fr)_150px_80px] items-center gap-3 border-b border-line/60 px-3 py-2 text-body last:border-b-0">
                  {/* the box on the name's first line, not in the middle of the name and its note */}
                  <Checkbox checked={on.has(f.name)} onChange={(v) => setTicked(() => { const n = new Set(on); if (v) n.add(f.name); else n.delete(f.name); return n; })} className="min-w-0 items-start! [&>span:first-child]:mt-px">
                    <span className="flex min-w-0 flex-col">
                      {/* the whole name: versions of one model often differ only at its end */}
                      <span className="break-all">{f.name}</span>
                      <span className="truncate text-xs text-ink-3">{[f.note, haveSaid(f), picked.has(f.name) ? "picked" : ""].filter(Boolean).join(" · ") || " "}</span>
                    </span>
                  </Checkbox>
                  {/* "none" is the "Which folder?" option: kept as no folder, never a folder of that name */}
                  <span data-tip={f.why}><Select size="sm" label={`Folder of ${f.name}`} value={folderOf(f) || "none"} onChange={(v) => setFolders((x) => ({ ...x, [f.name]: v === "none" ? "" : v }))} placeholder="Which folder?" options={[...(folderOf(f) ? [] : [{ value: "none", label: "Which folder?" }]), ...foldersOf(f).map((x) => ({ value: x, label: x }))]} /></span>
                  <span className="text-right font-mono text-xs text-ink-2">{f.bytes ? size(f.bytes) : "–"}</span>
                </div>
              ))}
              {!version.files.length && <span className="px-3 py-2 text-xs text-ink-2">No model file in it.</span>}
            </div>
          )}
          {version && version.trainedWords.length > 0 && <span className="text-xs text-ink-2">Trigger words: <span className="font-mono text-ink">{version.trainedWords.join(", ")}</span></span>}
          {card.site === "civitai" && (
            <span className="text-xs text-ink-3">
              {card.licence.commercial === false ? "no commercial use" : card.licence.commercial ? "commercial use allowed" : "commercial use: not said"}
              {card.licence.credit ? " · credit the creator" : ""}{card.licence.derivatives === false ? " · no derivatives" : ""}
            </span>
          )}
          <span className="flex items-center gap-2">
            <Button tone="primary" disabled={!chosen.length || lacksFolder} onClick={() => onPick(chosen.map((f) => pickedOf(f, card, version!.name, folderOf(f))))}>
              Pick {chosen.length > 1 ? plural(chosen.length, "file") : "it"}
            </Button>
            {lacksFolder && <span className="text-xs text-warn-ink">Say which folder it goes in.</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
