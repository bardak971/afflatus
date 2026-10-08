import { useState } from "react";
import { useLocation } from "wouter";
import { Film, Plus } from "lucide-react";
import { fuzzyScore } from "@afflatus/core";
import { useAddToTimeline } from "./actions";
import { thumbUrl, type Asset } from "./api";
import { useFolders, useTimelines } from "./data";
import { Dialog } from "./Dialog";
import { clock, when } from "./format";
import { useProject } from "./project";
import { Select } from "./Select";
import { useBanners, useStudio } from "./store";
import { Button, cx, ErrorNote, fieldClass } from "./ui";
import { foldersOf } from "./screens/library/tree";

/** Which timeline an item goes to the end of: one of the project's, or a new one. */
export function AddToTimeline({ asset, onClose }: { asset: Asset; onClose(): void }) {
  const timelines = useTimelines();
  const folderList = useFolders();
  // the folder the Studio looks at, to begin with: its timelines are the likely ones
  const place = useStudio((st) => st.place);
  const [folder, setFolder] = useState<string>(place.type === "folder" ? place.id : "any");
  const [typed, setTyped] = useState("");
  const [, go] = useLocation();
  const say = useBanners((b) => b.push);
  const add = useAddToTimeline(asset, {
    onSuccess: (target) => {
      say({ id: `add:${Date.now()}`, tone: "good", title: `Added to ${target.name}`, text: asset.kind === "image" ? "At the end, as a still." : "At the end.", href: `/timelines/${target.id}`, go: "Open the timeline" });
      onClose();
    },
  });
  // the folders of the project the rail looks at, as the Studio's own folder list shows them (All: every one)
  const project = useProject((st) => st.id);
  const folders = foldersOf((folderList.data?.items ?? []).filter((x) => !x.path), project);
  const items = (timelines.data?.items ?? [])
    .filter((t) => folder === "any" || (folder === "root" ? t.folderId === null : t.folderId === folder))
    .filter((t) => !typed.trim() || fuzzyScore(typed.trim(), t.name) !== null);
  return (
    <Dialog label="Add to a timeline" onClose={onClose} z="z-50" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
        <span className="text-base font-semibold">Add to a timeline</span>
        <span className="text-xs text-ink-2">{asset.kind === "image" ? "The image goes at the end, as a still you can animate or hold." : "The video goes at the end, as a clip of its own."}</span>
        {add.isError && <ErrorNote>{add.error.message}</ErrorNote>}
        <div className="flex gap-2">
          <input autoFocus data-search="add-timeline" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search timelines" aria-label="Search timelines" className={cx(fieldClass, "h-9 min-w-0 grow text-sm")} />
          <div className="w-44 shrink-0">
            <Select size="sm" label="Folder" value={folder} onChange={setFolder} options={[{ value: "any", label: "Every folder" }, ...folders.map((x) => ({ value: x.id, label: x.name })), { value: "root", label: "The project's root" }]} />
          </div>
        </div>
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {items.map((t) => (
            <button key={t.id} type="button" disabled={add.isPending} onClick={() => add.mutate(t.id)} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-left hover:border-accent">
              {t.cover ? <img src={thumbUrl(t.cover)} alt="" className="h-9 w-14 rounded object-cover" /> : <span className="flex h-9 w-14 items-center justify-center rounded bg-raised text-ink-3"><Film size={14} /></span>}
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate font-semibold">{t.name}</span>
                <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
              </span>
            </button>
          ))}
          {/* the folder list above is the one way to every folder: no button here that only shows with a folder picked */}
          {timelines.isSuccess && !items.length && <span className="text-ink-2">{typed.trim() ? "No timeline of that name here." : "No timeline in this folder."}</span>}
        </div>
        <div className="flex gap-2">
          <Button tone="primary" disabled={add.isPending} onClick={() => add.mutate(null)}><Plus size={14} strokeWidth={2.6} /> New timeline with it</Button>
          <Button tone="quiet" onClick={onClose}>Cancel</Button>
          <span className="grow" />
          <Button size="sm" tone="quiet" onClick={() => { onClose(); go("/timelines"); }}>All timelines</Button>
        </div>
    </Dialog>
  );
}
