import { useState, type DragEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Music, Pencil, Play, Trash2, VolumeX } from "lucide-react";
import { api, thumbUrl, type Asset, type Folder } from "../api";
import { useFolders, useStorage } from "../data";
import { clock, size } from "../format";
import { DRAG_HAS_SOUND, DRAG_TYPE, dragKind } from "../dragging";
import { cx, ErrorNote } from "../ui";

/** The pieces of the library that several screens use: a tile, what dragging one carries, and the folders. The screen itself is Studio. */

/** A result nobody kept goes to the bin a day after it was made: how long it has left. */
const UNKEPT_MS = 24 * 60 * 60_000;
function left(asset: Asset): string {
  const ms = new Date(asset.createdAt).getTime() + UNKEPT_MS - Date.now();
  return ms <= 0 ? "going to the bin" : ms < 60 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min left` : `${Math.round(ms / (60 * 60_000))} h left`;
}

/** Where the grid is looking: everything, what is in no folder, one folder, or the bin. */
export type Place = { type: "all" } | { type: "unfiled" } | { type: "folder"; id: string } | { type: "bin" };

export { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO, dragKind } from "../dragging";

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
        if (asset.kind === "video" && asset.hasSound) e.dataTransfer.setData(DRAG_HAS_SOUND, asset.id);
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

/**
 * The folders, as a panel: everything, each folder in its place in the tree, what is not filed yet,
 * the bin. A folder is a place to go to and a place to drop things on; the open one can be renamed
 * and deleted here, and a new one is made inside it.
 */
export function FolderPanel({ place, onPlace, dragging }: { place: Place; onPlace(p: Place): void; /** Something is being dragged: the panel is there to drop it on a folder. */ dragging?: boolean }) {
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
    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
      {dragging && <div className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-accent-ink">Drop it on a folder to file it</div>}
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

      <div className="my-1 border-t border-line" />
      <button type="button" onClick={() => onPlace({ type: "bin" })} className={row(place.type === "bin", "bin")}>
        <span className="flex items-center gap-2"><Trash2 size={14} /> Bin</span>
        {storage.data && storage.data.bin.count > 0 && <span className="shrink-0 font-normal text-ink-2">{storage.data.bin.count}</span>}
      </button>
      {storage.data && (
        <Link href="/settings" title="Where the space goes, and how to get some back: in Settings." className="px-2.5 pt-1 text-xs text-ink-2 hover:text-ink">
          {size(storage.data.total)} used
          {storage.data.idleTakes.bytes + storage.data.bin.bytes > 0 ? ` · ${size(storage.data.idleTakes.bytes + storage.data.bin.bytes)} could be freed` : ""}
        </Link>
      )}
      <div className="px-2.5 pt-1 text-xs text-ink-3">Drag a picture onto a folder to file it: filing by hand keeps it. What you make while a folder is open lands in it, and still has a day to be kept.</div>
    </div>
  );
}
