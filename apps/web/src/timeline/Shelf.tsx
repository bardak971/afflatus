import { useEffect, useMemo, useState } from "react";
import { LibraryBig, Music, PanelLeftClose, PanelLeftOpen, Play, Plus, Search } from "lucide-react";
import { api, thumbUrl, type Asset, type Timeline } from "../api";
import { HoverVideo } from "../HoverVideo";
import { Picker } from "../PictureField";
import { useAssets, useFolders } from "../data";
import { clock } from "../format";
import { useProject } from "../project";
import { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO } from "../screens/Library";
import { Select } from "../Select";
import { SHELF, useShelfWidth } from "../store";
import { Button, cx, SectionTitle, Segmented } from "../ui";

/**
 * The media beside the timeline: what this project has, what this timeline already uses, what was made
 * in the last two days, what was kept, or everything, with a search. Dragged onto the track, or added
 * at the end with a click. As wide as its edge is dragged; folded to a rail with a click.
 */

type Tab = "image" | "video" | "audio";
type Scope = "project" | "timeline" | "recent" | "kept" | "all";
const SCOPE_KEY = "afflatus.shelf.scope";
const DAY = 86_400_000;

const dragKind = (kind: Asset["kind"]) => (kind === "image" ? DRAG_PICTURE : kind === "video" ? DRAG_VIDEO : DRAG_SOUND);

/** "Today", "Yesterday", else the date: the heading a group of items sits under. */
const dayOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / DAY);
  return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

export function Shelf({ onAdd, selected, timeline }: {
  /** Pictures and videos go at the end of the timeline; a sound goes on the selected clip. */
  onAdd(asset: Asset): void;
  /** Whether a clip is selected (a sound needs one to go on). */
  selected: boolean;
  /** The timeline beside it: what it already uses is one of the scopes. */
  timeline: Timeline;
}) {
  const [tab, setTab] = useState<Tab>("image");
  const [scope, setScope] = useState<Scope>(() => {
    try {
      const s = localStorage.getItem(SCOPE_KEY);
      return s === "timeline" || s === "recent" || s === "kept" || s === "all" ? s : "project";
    } catch {
      return "project";
    }
  });
  const pickScope = (s: Scope) => {
    setScope(s);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      // not kept, nothing more
    }
  };
  const [folder, setFolder] = useState("");
  /** The whole library as a picker: one click adds what is picked. */
  const [browsing, setBrowsing] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const project = useProject((s) => s.id);
  const width = useShelfWidth((s) => s.width);
  const setWidth = useShelfWidth((s) => s.set);
  const collapsed = useShelfWidth((s) => s.collapsed);
  const fold = useShelfWidth((s) => s.fold);
  const folders = useFolders();
  const own = (folders.data?.items ?? []).filter((f) => (project === null ? true : project === "none" ? f.projectId === null : f.projectId === project));

  // the list: by scope (the project's media follows the switcher by itself)
  const since = useMemo(() => new Date(Date.now() - 2 * DAY).toISOString(), []);
  const fetched = scope !== "timeline";
  const assets = useAssets(
    {
      kind: tab,
      folder: scope === "project" || scope === "all" ? folder || undefined : undefined,
      q: q || undefined,
      since: scope === "recent" ? since : undefined,
      kept: scope === "kept" || undefined,
      all: scope === "all" || undefined,
    },
    fetched && !collapsed,
  );
  /** What this timeline already uses: every take's video, the stills, the sound files, the music. */
  const used = useMemo(() => {
    const seen = new Map<string, Asset>();
    for (const c of timeline.clips) {
      for (const t of c.takes) seen.set(t.asset.id, t.asset);
      if (c.still) seen.set(c.still.id, c.still);
      if (c.soundAsset) seen.set(c.soundAsset.id, c.soundAsset);
    }
    if (timeline.music) seen.set(timeline.music.asset.id, timeline.music.asset);
    const needle = q.toLowerCase();
    return [...seen.values()].filter((a) => a.kind === tab && (!needle || (a.name ?? "").toLowerCase().includes(needle)));
  }, [timeline, tab, q]);
  const items = fetched ? (assets.data?.pages.flatMap((p) => p.items) ?? []) : used;
  // grouped by the day they were made, newest first (what the timeline uses is one group)
  const groups = useMemo(() => {
    if (!fetched) return [{ day: "", items }];
    const out: Array<{ day: string; items: Asset[] }> = [];
    for (const a of items) {
      const day = dayOf(a.createdAt);
      const last = out.at(-1);
      if (last && last.day === day) last.items.push(a);
      else out.push({ day, items: [a] });
    }
    return out;
  }, [items, fetched]);

  const drag = (a: Asset) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, a.id);
    e.dataTransfer.setData(dragKind(a.kind), a.id);
    e.dataTransfer.effectAllowed = "copy";
  };
  const what = (a: Asset) => (a.kind === "video" ? "Add this video at the end of the timeline" : a.kind === "image" ? "Add this image at the end, as a still" : selected ? "Use this audio on the selected clip" : "Select a clip first, or drag this audio file onto one");
  const scopeName = project === null ? "Everything" : project === "none" ? "The Inbox" : "This project";
  const scopes: Array<{ value: Scope; label: string; note?: string }> = [
    { value: "project", label: scopeName, note: project === null ? "the whole library" : "as the switcher says" },
    { value: "timeline", label: "In this timeline", note: `${used.length} used` },
    { value: "recent", label: "Recent", note: "made in the last 48 hours" },
    { value: "kept", label: "Kept", note: "starred" },
    ...(project !== null ? [{ value: "all" as const, label: "Everything", note: "every project" }] : []),
  ];
  const empty = tab === "audio" ? "No audio here. Import a file from your computer." : scope === "timeline" ? `This timeline uses no ${tab === "image" ? "image" : "video"} yet.` : `No ${tab === "image" ? "images" : "videos"} here.`;

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-line bg-panel py-2">
        <button type="button" aria-label="Show the media" title="Show the media (your library beside the timeline)" onClick={() => fold(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><PanelLeftOpen size={16} /></button>
        <span className="mt-3 text-[10px] font-semibold tracking-wide text-ink-3 uppercase [writing-mode:vertical-rl]">Media</span>
      </aside>
    );
  }

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-line bg-panel" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to make the media shelf wider or narrower"
        title="Drag to make the shelf wider or narrower; double-click for the usual width"
        onPointerDown={(e) => {
          const startX = e.clientX;
          const startWidth = useShelfWidth.getState().width;
          e.currentTarget.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => setWidth(startWidth + (ev.clientX - startX));
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onDoubleClick={() => setWidth(SHELF.usual)}
        className="absolute top-0 -right-0.5 bottom-0 z-20 w-1.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
      />
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Your media</SectionTitle>
          <span className="grow" />
          <button type="button" aria-label="Fold the media away" title="Fold the media away, for a wider stage" onClick={() => fold(true)} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"><PanelLeftClose size={14} /></button>
        </div>
        <Select size="sm" label="Where to look" value={scope} onChange={(v) => pickScope(v as Scope)} options={scopes} />
        <Segmented<Tab> label="Media type" value={tab} onChange={setTab} options={[{ value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }]} />
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input data-search="shelf" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={scope === "timeline" ? "Find by name" : "Find by prompt or name"} className="min-w-0 grow bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
        </label>
        {(scope === "project" || scope === "all") && own.length > 0 && (
          <Select size="sm" label="Folder" value={folder} onChange={setFolder} options={[{ value: "", label: scope === "all" ? "All folders" : "All its folders" }, ...own.map((f) => ({ value: f.id, label: f.name, note: `${f.count}` }))]} />
        )}
        <Button size="sm" onClick={() => setBrowsing(true)} title="The whole library, large, with a search: one click adds what you pick"><LibraryBig size={13} /> Browse the library</Button>
      </div>
      {browsing && (
        <Picker
          title={tab === "audio" ? (selected ? "Audio for the selected clip" : "Audio (select a clip first)") : tab === "video" ? "Add a video at the end of the timeline" : "Add an image at the end, as a still"}
          kind={tab}
          onClose={() => setBrowsing(false)}
          onPick={(id) => {
            setBrowsing(false);
            void api.asset(id).then((a) => onAdd(a)).catch(() => {});
          }}
        />
      )}
      <div className="min-h-0 grow overflow-y-auto px-3 pb-3">
        {(fetched ? assets.isSuccess : true) && !items.length && <div className="py-6 text-center text-xs text-ink-3">{empty}</div>}
        {groups.map((g) => (
          <div key={g.day || "used"} className="mb-2">
            {g.day && <div className="sticky top-0 z-10 -mx-3 mb-1.5 bg-panel/95 px-3 py-1 text-[10px] font-semibold tracking-wide text-ink-3 uppercase">{g.day}</div>}
            {tab === "audio" ? (
              <div className="flex flex-col gap-1.5">
                {g.items.map((a) => (
                  <button key={a.id} type="button" draggable onDragStart={drag(a)} onClick={() => onAdd(a)} title={what(a)} aria-label={what(a)} className="flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-left hover:border-accent">
                    <Music size={13} className="shrink-0 text-ink-2" />
                    <span className="min-w-0 grow truncate text-xs">{a.name || "Audio file"}</span>
                    {a.durationMs ? <span className="shrink-0 font-mono text-[11px] text-ink-2">{clock(a.durationMs)}</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
                {g.items.map((a) => (
                  <div key={a.id} draggable onDragStart={drag(a)} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent">
                    <HoverVideo asset={a.id} video={a.kind === "video"} alt={a.name} />
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
          </div>
        ))}
        {fetched && assets.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>Show more</Button>
          </div>
        )}
      </div>
    </aside>
  );
}
