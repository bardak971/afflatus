import { useEffect, useState, type DragEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, FolderPlus, Music, Pencil, Play, Plus, Search, Star, Trash2, VolumeX, X } from "lucide-react";
import { api, thumbUrl, type Asset, type Folder } from "../api";
import { useAssetFamilies, useAssets, useFolders, useRecipes, useStorage, useTimelines } from "../data";
import { clock, size, when } from "../format";
import { Select } from "../Select";
import { useHandover } from "../store";
import { Button, cx, Empty, ErrorNote, SectionTitle } from "../ui";
import { Viewer } from "../Viewer";

const KINDS = [
  { id: "all", label: "Everything", kind: undefined },
  { id: "image", label: "Pictures", kind: "image" },
  { id: "video", label: "Videos", kind: "video" },
  { id: "audio", label: "Sounds", kind: "audio" },
  { id: "timeline", label: "Timelines", kind: undefined },
] as const;

/** A result nobody kept goes to the bin a day after it was made: how long it has left. */
const UNKEPT_MS = 24 * 60 * 60_000;
function left(asset: Asset): string {
  const ms = new Date(asset.createdAt).getTime() + UNKEPT_MS - Date.now();
  return ms <= 0 ? "going to the bin" : ms < 60 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min left` : `${Math.round(ms / (60 * 60_000))} h left`;
}

/** Where the grid is looking: everything, what is in no folder, one folder, or the bin. */
type Place = { type: "all" } | { type: "unfiled" } | { type: "folder"; id: string } | { type: "bin" };

export const DRAG_TYPE = "application/x-studai-asset";
/** Also set, by what is dragged: a drop target can only see these names while something hovers over it, not the item. */
export const DRAG_PICTURE = "application/x-studai-picture";
export const DRAG_VIDEO = "application/x-studai-video";
export const DRAG_SOUND = "application/x-studai-sound";
export const dragKind = (kind: "image" | "video" | "audio") => (kind === "image" ? DRAG_PICTURE : kind === "video" ? DRAG_VIDEO : DRAG_SOUND);

export function Tile({ asset, onOpen }: { asset: Asset; onOpen(): void }) {
  // a video has a preview frame when the server could read one from it
  const [noFrame, setNoFrame] = useState(false);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, asset.id);
        e.dataTransfer.setData(dragKind(asset.kind), asset.id);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={onOpen}
      aria-label={`Open ${asset.kind === "image" ? "picture" : asset.kind}`}
      className="group relative aspect-[3/4] overflow-hidden rounded-[10px] border border-line bg-panel"
    >
      {asset.kind === "image" || (asset.kind === "video" && !noFrame) ? (
        <img src={thumbUrl(asset.id)} alt="" loading="lazy" draggable={false} onError={() => setNoFrame(true)} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-2">
          {asset.kind === "video" ? <Play size={20} /> : <Music size={20} />}
          {asset.kind === "video" ? "Video" : "Sound"}
        </span>
      )}
      {asset.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">
          <Play size={10} fill="currentColor" />
          {asset.durationMs ? clock(asset.durationMs) : "Video"}
          {asset.durationMs !== null && !asset.hasSound && <VolumeX size={11} aria-label="No sound" className="text-ink-2" />}
        </span>
      )}
      {!asset.kept && !asset.inBin && (
        <span title="Deleted then unless you keep it." className="absolute top-2 right-2 rounded-full bg-warn px-2 py-0.5 text-[10px] font-bold text-[#2a0e00]">{left(asset)}</span>
      )}
    </button>
  );
}

/** Folders in reading order, each with how deep it sits. */
function tree(folders: Folder[]): Array<Folder & { depth: number }> {
  const out: Array<Folder & { depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent)) {
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  // a folder whose parent is missing still has to be reachable
  for (const f of folders) if (!out.some((x) => x.id === f.id)) out.push({ ...f, depth: 0 });
  return out;
}

function Folders({ place, onPlace }: { place: Place; onPlace(p: Place): void }) {
  const folders = useFolders();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["assets"] });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [text, setText] = useState("");
  const storage = useStorage();

  const selected = place.type === "folder" ? place.id : null;
  const create = useMutation({ mutationFn: (name: string) => api.createFolder(name, selected), onSuccess: refresh });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editFolder(v.id, { name: v.name }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: api.deleteFolder,
    onSuccess: (_r, id) => {
      if (selected === id) onPlace({ type: "all" });
      return refresh();
    },
  });
  const move = useMutation({ mutationFn: (v: { asset: string; folder: string | null }) => api.moveAssets([v.asset], v.folder), onSuccess: refresh });

  /** A row that items can be dropped on. */
  const drop = (key: string, folder: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const asset = e.dataTransfer.getData(DRAG_TYPE);
      if (asset) move.mutate({ asset, folder });
    },
  });
  const row = (on: boolean, key: string) =>
    cx("flex h-[34px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left", on ? "bg-hover font-semibold text-white" : "text-ink hover:bg-raised", over === key && "outline outline-2 outline-accent");

  const submit = (then: (name: string) => void) => (e: React.FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (name) then(name);
    setAdding(false);
    setEditing(null);
    setText("");
  };
  const error = create.error ?? rename.error ?? remove.error ?? move.error ?? folders.error;

  return (
    <aside className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel px-2.5 py-3.5">
      <div className="px-2 pb-1.5"><SectionTitle>Folders</SectionTitle></div>
      <button type="button" onClick={() => onPlace({ type: "all" })} className={row(place.type === "all", "all")}>Everything</button>
      {tree(folders.data?.items ?? []).map((f) =>
        editing === f.id ? (
          <form key={f.id} onSubmit={submit((name) => rename.mutate({ id: f.id, name }))} style={{ paddingLeft: f.depth * 14 }}>
            <input autoFocus aria-label="Folder name" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setEditing(null)} className="h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5" />
          </form>
        ) : (
          <div key={f.id} style={{ paddingLeft: f.depth * 14 }}>
            <button type="button" onClick={() => onPlace({ type: "folder", id: f.id })} className={row(selected === f.id, f.id)} {...drop(f.id, f.id)}>
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 font-normal text-ink-2">{f.count}</span>
            </button>
            {selected === f.id && (
              <div className="flex items-center gap-1 py-1 pl-1.5">
                {deleting === f.id ? (
                  <>
                    <span className="text-xs text-ink-2">Its items move up.</span>
                    <button type="button" onClick={() => { remove.mutate(f.id); setDeleting(null); }} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-[#2a0e00]">Delete</button>
                    <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => { setEditing(f.id); setText(f.name); }} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={12} /> Rename</button>
                    <button type="button" onClick={() => setDeleting(f.id)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink"><Trash2 size={12} /> Delete</button>
                  </>
                )}
              </div>
            )}
          </div>
        ),
      )}
      <button type="button" onClick={() => onPlace({ type: "unfiled" })} className={row(place.type === "unfiled", "unfiled")} {...drop("unfiled", null)}>Not filed yet</button>

      {adding ? (
        <form onSubmit={submit((name) => create.mutate(name))}>
          <input autoFocus aria-label="Name of the new folder" placeholder={selected ? "New folder inside it" : "New folder"} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { if (!text.trim()) setAdding(false); }} className="h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5" />
        </form>
      ) : (
        <button type="button" onClick={() => { setAdding(true); setText(""); }} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-ink-2 hover:bg-raised hover:text-ink">
          <FolderPlus size={14} /> New folder
        </button>
      )}
      {error && <ErrorNote>{error.message}</ErrorNote>}

      <span className="grow" />
      <button type="button" onClick={() => onPlace({ type: "bin" })} className={row(place.type === "bin", "bin")}>
        <span className="flex items-center gap-2"><Trash2 size={14} /> Bin</span>
        {storage.data && storage.data.bin.count > 0 && <span className="shrink-0 font-normal text-ink-2">{storage.data.bin.count}</span>}
      </button>
      {storage.data && (
        <Link href="/setup" title="Where the space goes, and how to get some back: in Setup." className="px-2.5 pt-1 text-xs text-ink-2 hover:text-ink">
          {size(storage.data.total)} used
          {storage.data.idleTakes.bytes + storage.data.bin.bytes > 0 ? ` · ${size(storage.data.idleTakes.bytes + storage.data.bin.bytes)} could be freed` : ""}
        </Link>
      )}
      <div className="px-2.5 pt-1 text-xs text-ink-3">Drag a picture onto a folder to file it. Filing keeps it.</div>
    </aside>
  );
}

export function Library() {
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [place, setPlace] = useState<Place>({ type: "all" });
  const [open, setOpen] = useState<Asset | null>(null);
  // an item just dropped on the app: opened large, with everything that can be done with it
  const shown = useHandover((h) => h.show);
  const hand = useHandover((h) => h.set);
  useEffect(() => {
    if (!shown) return;
    hand({ show: null });
    void api.asset(shown).then((a) => setOpen(a)).catch(() => {});
  }, [shown, hand]);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [family, setFamily] = useState("");
  const [kept, setKept] = useState(false);
  // what is typed is looked for once the typing stops
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const showTimelines = kind === "timeline" && place.type !== "bin";
  const assets = useAssets({
    kind: KINDS.find((k) => k.id === kind)!.kind,
    bin: place.type === "bin" || undefined,
    folder: place.type === "folder" ? place.id : place.type === "unfiled" ? "none" : undefined,
    q: q || undefined,
    family: family || undefined,
    kept: kept || undefined,
  });
  const items = showTimelines ? [] : assets.data?.pages.flatMap((p) => p.items) ?? [];
  const timelines = useTimelines();
  const families = useAssetFamilies();
  const recipes = useRecipes();
  const familyName = (id: string) => recipes.data?.families.find((f) => f.id === id)?.name ?? id;
  const filtered = Boolean(q || family || kept);

  return (
    <div className="flex min-h-0 grow">
      <Folders place={place} onPlace={setPlace} />
      <div className="flex min-w-0 grow flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-2 px-5">
          <h1 className="mr-3 text-base font-semibold">{place.type === "bin" ? "Bin" : "Library"}</h1>
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cx("h-[30px] rounded-full border px-3 text-xs font-semibold", kind === k.id ? "border-ink bg-ink text-ground" : "border-line text-ink-2 hover:text-ink")}
            >
              {k.label}
            </button>
          ))}
          <span className="grow" />
          <label className="flex h-9 w-72 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input aria-label="Search your library" placeholder="Search by what you wrote, or by name" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
            {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          {(families.data?.items.length ?? 0) > 0 && (
            <div className="w-40">
              <Select size="sm" className="h-9" label="Made with" value={family} onChange={setFamily} options={[{ value: "", label: "Any model" }, ...families.data!.items.map((f) => ({ value: f, label: familyName(f) }))]} />
            </div>
          )}
          <button type="button" aria-pressed={kept} onClick={() => setKept(!kept)} className={cx("flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
            <Star size={13} fill={kept ? "currentColor" : "none"} /> Kept only
          </button>
          <Link href="/create" className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 font-bold text-accent-ink">
            <Plus size={15} strokeWidth={2.6} /> New
          </Link>
        </header>

        <div className="min-h-0 grow overflow-y-auto px-5 pb-6">
          {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
          {showTimelines && (
            <>
              {timelines.isSuccess && !timelines.data.items.length && <Empty title="No timeline yet">A timeline plays clips one after the other. Start one in Timelines.</Empty>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
                {timelines.data?.items.map((t) => (
                  <Link key={t.id} href={`/timelines/${t.id}`} className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel hover:border-accent">
                    <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
                      {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
                    </span>
                    <span className="flex flex-col px-3 py-2">
                      <span className="truncate font-semibold">{t.name}</span>
                      <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
          {!showTimelines && assets.isSuccess && !items.length && (
            <Empty title={filtered ? "Nothing matches" : place.type === "bin" ? "The bin is empty" : place.type === "folder" ? "This folder is empty" : "Nothing here yet"}>
              {filtered
                ? "Nothing here was made with these words, this model or was kept. Change the search or the filters."
                : place.type === "bin"
                  ? "Things you delete wait here a week before they are removed for good."
                  : place.type === "folder"
                    ? "Drag pictures onto it from Everything."
                    : "Pictures and videos you make appear here. Start with New."}
            </Empty>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {items.map((a) => <Tile key={a.id} asset={a} onOpen={() => setOpen(a)} />)}
          </div>
          {!showTimelines && assets.hasNextPage && (
            <div className="mt-5 flex justify-center">
              <Button onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>{assets.isFetchingNextPage ? "Loading…" : "Show more"}</Button>
            </div>
          )}
        </div>
      </div>

      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} onClose={() => setOpen(null)} />}
    </div>
  );
}
