import { useState } from "react";
import { Music, Play, Plus } from "lucide-react";
import { thumbUrl, type Asset } from "../api";
import { useAssets, useFolders } from "../data";
import { useProject } from "../project";
import { clock } from "../format";
import { DRAG_TYPE, dragKind } from "../screens/Library";
import { Select } from "../Select";
import { Button, SectionTitle, Segmented } from "../ui";

type Tab = "image" | "video" | "audio";
/** Your library, beside the timeline: what can be dragged onto it. */
export function Shelf({ onAdd, selected }: {
  /** Pictures and videos go at the end of the timeline; a sound goes on the selected clip. */
  onAdd(asset: Asset): void;
  /** Whether a clip is selected (a sound needs one to go on). */
  selected: boolean;
}) {
  const [tab, setTab] = useState<Tab>("image");
  const [folder, setFolder] = useState("");
  const assets = useAssets({ kind: tab, folder: folder || undefined });
  const folders = useFolders();
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  const project = useProject((s) => s.id);
  const all = (folders.data?.items ?? []).filter((f) => (project === null ? true : project === "none" ? f.projectId === null : f.projectId === project));
  const drag = (a: Asset) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, a.id);
    e.dataTransfer.setData(dragKind(a.kind), a.id);
    e.dataTransfer.effectAllowed = "copy";
  };
  const what = (a: Asset) => (a.kind === "video" ? "Add this video at the end of the timeline" : a.kind === "image" ? "Add this image at the end, as a still" : selected ? "Use this audio on the selected clip" : "Select a clip first, or drag this audio file onto one");

  return (
    <aside className="flex w-[224px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <SectionTitle>Your media</SectionTitle>
        <Segmented<Tab> label="Media type" value={tab} onChange={setTab} options={[{ value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }]} />
        {all.length > 0 && (
          <Select size="sm" label="Folder" value={folder} onChange={setFolder} options={[{ value: "", label: "All folders" }, ...all.map((f) => ({ value: f.id, label: f.name, note: `${f.count}` }))]} />
        )}
      </div>
      <div className="min-h-0 grow overflow-y-auto px-3 pb-3">
        {assets.isSuccess && !items.length && (
          <div className="py-6 text-center text-xs text-ink-3">{tab === "audio" ? "No audio yet. Import a file from your computer." : `No ${tab === "image" ? "images" : "videos"} here yet.`}</div>
        )}
        {tab === "audio" ? (
          <div className="flex flex-col gap-1.5">
            {items.map((a) => (
              <button key={a.id} type="button" draggable onDragStart={drag(a)} onClick={() => onAdd(a)} title={what(a)} aria-label={what(a)} className="flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-left hover:border-accent">
                <Music size={13} className="shrink-0 text-ink-2" />
                <span className="min-w-0 grow truncate text-xs">{a.name || "Audio file"}</span>
                {a.durationMs ? <span className="shrink-0 font-mono text-[11px] text-ink-2">{clock(a.durationMs)}</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {items.map((a) => (
              <div key={a.id} draggable onDragStart={drag(a)} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent">
                <img src={thumbUrl(a.id)} alt={a.name} loading="lazy" draggable={false} className="h-full w-full object-cover" />
                {a.kind === "video" && (
                  <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-ground/80 px-1 py-px text-[10px] font-semibold">
                    <Play size={8} fill="currentColor" />
                    {a.durationMs ? clock(a.durationMs) : "Video"}
                  </span>
                )}
                <button type="button" onClick={() => onAdd(a)} title={what(a)} aria-label={what(a)} className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-ground/85 text-ink opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                  <Plus size={13} strokeWidth={2.6} />
                </button>
              </div>
            ))}
          </div>
        )}
        {assets.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>Show more</Button>
          </div>
        )}
      </div>
    </aside>
  );
}
