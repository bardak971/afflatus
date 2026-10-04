import { useRef, useState, type DragEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, Film, Folder as FolderIcon, FolderPlus, FolderUp, HardDrive, Link2, Music, Pencil, Play, RefreshCw, Trash2, Unlink, VolumeX } from "lucide-react";
import { HoverVideo } from "../HoverVideo";
import { api, thumbUrl, type Asset, type Folder } from "../api";
import { useFolders, useStorage } from "../data";
import { projectForNew, useProject } from "../project";
import { clock, size } from "../format";
import { DRAG_HAS_SOUND, DRAG_TYPE, dragKind } from "../dragging";
import { useFolderImport } from "../folderImport";
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

export function Tile({ asset, onOpen, selected, selecting, onSelect, dragIds, onMenu }: {
  asset: Asset;
  onOpen(): void;
  /** It is one of the items ticked; and whether any is: a click then ticks instead of opening. */
  selected?: boolean;
  selecting?: boolean;
  /** Tick or untick it. With the Shift key held: everything from the last one ticked to this one. */
  onSelect?(range: boolean): void;
  /** What a drag of it carries: every ticked item when it is one of them. */
  dragIds?: string[];
  /** A right-click: the menu of what can be done with it. */
  onMenu?(e: React.MouseEvent): void;
}) {
  // a video has a preview frame when the server could read one from it
  const [noFrame, setNoFrame] = useState(false);
  return (
    <button
      type="button"
      draggable
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, (dragIds ?? [asset.id]).join(","));
        e.dataTransfer.setData(dragKind(asset.kind), asset.id);
        if (asset.kind === "video" && asset.hasSound) e.dataTransfer.setData(DRAG_HAS_SOUND, asset.id);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={(e) => {
        // with something ticked, or with Ctrl or Shift held, a click ticks; otherwise it opens
        if (onSelect && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) onSelect(e.shiftKey);
        else onOpen();
      }}
      aria-label={`Open ${asset.kind}`}
      onContextMenu={onMenu}
      data-stage
      className={cx("group relative block w-full aspect-[3/4] overflow-hidden rounded-[10px] border bg-panel", selected ? "border-2 border-accent" : "border-line")}
    >
      {onSelect && (
        <span
          role="checkbox"
          aria-checked={Boolean(selected)}
          aria-label="Select, to move, keep or delete several at once"
          title="Select (also Ctrl + click; Shift + click selects the range)"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(e.shiftKey);
          }}
          className={cx(
            "absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] text-[11px] font-bold",
            selected ? "border-accent bg-accent text-accent-ink" : "border-white/80 bg-ground/60 text-transparent",
            !selected && !selecting && "opacity-0 group-hover:opacity-100",
          )}
        >
          ✓
        </span>
      )}
      {asset.kind === "image" || (asset.kind === "video" && !noFrame) ? (
        <HoverVideo asset={asset.id} video={asset.kind === "video"} onNoFrame={() => setNoFrame(true)} />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-2">
          {asset.kind === "video" ? <Play size={20} /> : <Music size={20} />}
          {asset.kind === "video" ? "Video" : "Audio"}
        </span>
      )}
      {asset.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">
          <Play size={10} fill="currentColor" />
          {asset.durationMs ? clock(asset.durationMs) : "Video"}
          {asset.durationMs !== null && !asset.hasSound && <VolumeX size={11} aria-label="No audio" className="text-ink-2" />}
        </span>
      )}
      {!asset.kept && !asset.inBin && (
        <span title="Goes to the bin then unless you keep it." className="absolute top-2 right-2 rounded-full bg-warn px-2 py-0.5 text-[10px] font-bold text-warn-on">{left(asset)}</span>
      )}
      {asset.clipOf && <ClipMark of={asset.clipOf} className="absolute right-2 bottom-2" />}
    </button>
  );
}

/** On a video that is a take of a timeline clip: the clip's number, the rest on hover. */
export function ClipMark({ of, className }: { of: NonNullable<Asset["clipOf"]>; className?: string }) {
  const what = `${of.timelineName}: clip ${of.clip}${of.takes > 1 ? `, take ${of.take} of ${of.takes}` : ""}${of.playing ? " (the one playing)" : of.takes > 1 ? " (not the one playing)" : ""}${of.upscaledBy ? `, upscaled${of.upscaledBy !== 1 ? ` ×${of.upscaledBy}` : ""}` : ""}`;
  return (
    <span title={what} aria-label={what} className={cx("flex items-center gap-1 rounded-md bg-ground/80 px-1.5 py-0.5 text-[10px] font-semibold", of.playing || of.takes === 1 ? "text-accent" : "text-ink-2", className)}>
      <Film size={9} />
      {of.clip}
      {of.takes > 1 && <span className="font-normal text-ink-2">·{of.take}</span>}
    </span>
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
  // a new folder: inside the one that is open, or at the top; or a directory of the disk to link
  const [adding, setAdding] = useState<false | "inside" | "top" | "link">(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [text, setText] = useState("");
  const storage = useStorage();
  // the bin, emptied now instead of waiting a week: asked twice, it cannot be undone
  const [emptying, setEmptying] = useState(false);
  const empty = useMutation({
    mutationFn: api.emptyBin,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["assets"] });
      void client.invalidateQueries({ queryKey: ["timelines"] });
    },
  });

  const selected = place.type === "folder" ? place.id : null;
  // the folders of the project the app looks at (the Inbox: those in none; All: every one)
  const project = useProject((s) => s.id);
  const scoped = (folders.data?.items ?? []).filter((f) => (project === null ? true : project === "none" ? f.projectId === null : f.projectId === project));
  const create = useMutation({ mutationFn: (v: { name: string; parent: string | null }) => api.createFolder(v.name, v.parent, v.parent ? undefined : projectForNew()), onSuccess: refresh });
  const open = (folders.data?.items ?? []).find((f) => f.id === selected);
  // a whole folder of the computer, brought in with its sub-folders: into the folder that is open, or at the top
  const picker = useRef<HTMLInputElement>(null);
  const bringIn = useFolderImport((s) => s.start);
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editFolder(v.id, { name: v.name }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: api.deleteFolder,
    onSuccess: (_r, id) => {
      if (selected === id) onPlace({ type: "all" });
      return refresh();
    },
  });
  const move = useMutation({ mutationFn: (v: { asset: string; folder: string | null }) => api.moveAssets(v.asset.split(",").filter(Boolean), v.folder), onSuccess: refresh });
  const link = useMutation({ mutationFn: (path: string) => api.linkFolder(path), onSuccess: async (made) => {
      // the list of folders first: a folder that is not in it yet is no place to go to
      await refresh();
      onPlace({ type: "folder", id: made.id });
    },
  });
  const look = useMutation({ mutationFn: api.scanFolder, onSuccess: refresh });

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
    cx("flex h-[34px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left", on ? "bg-hover font-semibold text-ink-strong" : "text-ink hover:bg-raised", over === key && "outline outline-2 outline-accent");

  const submit = (then: (name: string) => void) => (e: React.FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (name) then(name);
    setAdding(false);
    setEditing(null);
    setText("");
  };
  const error = create.error ?? rename.error ?? remove.error ?? move.error ?? link.error ?? look.error ?? empty.error ?? folders.error;

  return (
    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
      {dragging && <div className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-accent-ink">Drop on a folder to move it there</div>}
      <button type="button" onClick={() => onPlace({ type: "all" })} className={row(place.type === "all", "all")}>All</button>
      {tree(scoped).map((f) =>
        editing === f.id ? (
          <form key={f.id} onSubmit={submit((name) => rename.mutate({ id: f.id, name }))} style={{ paddingLeft: f.depth * 14 }}>
            <input autoFocus aria-label="Folder name" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setEditing(null)} className="h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5" />
          </form>
        ) : (
          <div key={f.id} style={{ paddingLeft: f.depth * 16 }}>
            <button type="button" onClick={() => onPlace({ type: "folder", id: f.id })} className={row(selected === f.id, f.id)} {...drop(f.id, f.id)}>
              <span className="flex min-w-0 items-center gap-2">
                {/* a folder inside another one sits under it, with an arrow that says so */}
                {f.depth > 0 ? <CornerDownRight size={13} className="shrink-0 text-ink-3" /> : f.path ? <HardDrive size={14} className="shrink-0 text-ink-2" /> : <FolderIcon size={14} className="shrink-0 text-ink-2" />}
                <span className="truncate" title={f.path ?? undefined}>{f.name}</span>
              </span>
              <span className="shrink-0 font-normal text-ink-2">{f.count}</span>
            </button>
            {selected === f.id && f.path && (
              // a folder of the disk: it is read again on request; the linked one can be renamed here and unlinked, its sub-directories are changed on the disk
              <div className="flex flex-col gap-1 py-1 pl-1.5">
                <span className="truncate font-mono text-[11px] text-ink-3" title={f.path}>{f.path}</span>
                <div className="flex flex-wrap items-center gap-1">
                  {deleting === f.id ? (
                    <>
                      <span className="text-xs text-ink-2">Nothing on your disk is touched.</span>
                      <button type="button" onClick={() => { remove.mutate(f.id); setDeleting(null); }} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Unlink</button>
                      <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={look.isPending} title="Scan the folder on your disk again: what was added appears, what was removed is gone" onClick={() => look.mutate(f.id)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink"><RefreshCw size={12} /> {look.isPending ? "Scanning…" : "Rescan"}</button>
                      {f.root && <button type="button" onClick={() => { setEditing(f.id); setText(f.name); }} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink"><Pencil size={12} /> Rename</button>}
                      {f.root && <button type="button" onClick={() => setDeleting(f.id)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink"><Unlink size={12} /> Unlink</button>}
                    </>
                  )}
                </div>
              </div>
            )}
            {selected === f.id && !f.path && (
              <div className="flex items-center gap-1 py-1 pl-1.5">
                {deleting === f.id ? (
                  <>
                    <span className="text-xs text-ink-2">Its items move to the parent folder.</span>
                    <button type="button" onClick={() => { remove.mutate(f.id); setDeleting(null); }} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Delete</button>
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
      <button type="button" onClick={() => onPlace({ type: "unfiled" })} className={row(place.type === "unfiled", "unfiled")} {...drop("unfiled", null)}>No folder</button>

      {adding ? (
        <form className="flex flex-col gap-1" onSubmit={submit((name) => (adding === "link" ? link.mutate(name) : create.mutate({ name, parent: adding === "inside" ? selected : null })))}>
          <input
            autoFocus
            aria-label={adding === "link" ? "Folder path on the disk" : "New folder name"}
            placeholder={adding === "link" ? "Folder path, for example D:\\images\\shoots" : adding === "inside" && open ? `New folder name, inside ${open.name}` : "New folder name"}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (!text.trim()) setAdding(false); }}
            className={cx("h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5", adding === "link" && "font-mono text-xs")}
          />
          {adding === "link" && <span className="px-1 text-xs text-ink-3">A folder the computer Afflatus runs on can read. Its images, videos and audio files show here and are used in place; nothing is copied. Press Enter.</span>}
        </form>
      ) : (
        <>
          {open && (
            <button type="button" onClick={() => { setAdding("inside"); setText(""); }} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-left text-ink-2 hover:bg-raised hover:text-ink">
              <CornerDownRight size={14} className="shrink-0" /> <span className="truncate">New folder inside {open.name}</span>
            </button>
          )}
          <button type="button" onClick={() => { setAdding("top"); setText(""); }} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-ink-2 hover:bg-raised hover:text-ink">
            <FolderPlus size={14} /> {open ? "New top-level folder" : "New folder"}
          </button>
        </>
      )}
      {!adding && (
        <button type="button" title="A folder of the disk Afflatus runs on, shown here with its sub-folders. Its files are used in place, nothing is copied." onClick={() => { setAdding("link"); setText(""); }} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-left text-ink-2 hover:bg-raised hover:text-ink">
          <Link2 size={14} className="shrink-0" /> <span className="truncate">Link a local folder</span>
        </button>
      )}
      <button type="button" title="Every image, video and audio file in a folder of your computer is copied into the library, with its sub-folders" onClick={() => picker.current?.click()} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-left text-ink-2 hover:bg-raised hover:text-ink">
        <FolderUp size={14} className="shrink-0" /> <span className="truncate">Import a folder{open ? ` into ${open.name}` : ""}</span>
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        // a whole directory, sub-directories included
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void bringIn(files, selected, client);
        }}
      />
      {error && <ErrorNote>{error.message}</ErrorNote>}

      <div className="my-1 border-t border-line" />
      <button type="button" onClick={() => onPlace({ type: "bin" })} className={row(place.type === "bin", "bin")}>
        <span className="flex items-center gap-2"><Trash2 size={14} /> Bin</span>
        {storage.data && storage.data.bin.count > 0 && <span className="shrink-0 font-normal text-ink-2">{storage.data.bin.count}</span>}
      </button>
      {storage.data && storage.data.bin.count > 0 && (
        <div className="flex flex-wrap items-center gap-1 py-1 pl-1.5">
          {emptying ? (
            <>
              <span className="text-xs text-ink-2">This cannot be undone.</span>
              <button type="button" disabled={empty.isPending} onClick={() => { empty.mutate(); setEmptying(false); }} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Erase {size(storage.data.bin.bytes)}</button>
              <button type="button" onClick={() => setEmptying(false)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
            </>
          ) : (
            <button type="button" disabled={empty.isPending} title="Everything in the bin is erased now, files and all, instead of after its 7 days." onClick={() => setEmptying(true)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink">
              <Trash2 size={12} /> {empty.isPending ? "Emptying…" : `Empty bin · ${size(storage.data.bin.bytes)}`}
            </button>
          )}
        </div>
      )}
      {storage.data && (
        <Link href="/settings/storage" title="Disk usage breakdown and how to free space: in Settings." className="px-2.5 pt-1 text-xs text-ink-2 hover:text-ink">
          {size(storage.data.total)} used
          {storage.data.idleTakes.bytes + storage.data.bin.bytes > 0 ? ` · ${size(storage.data.idleTakes.bytes + storage.data.bin.bytes)} could be freed` : ""}
        </Link>
      )}
      <div className="px-2.5 pt-1 text-xs text-ink-3">Drag an image onto a folder to move it there: moving it by hand keeps it. What you generate while a folder is open lands in it, and still has a day to be kept.</div>
    </div>
  );
}
