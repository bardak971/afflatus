import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, Folder as FolderIcon, FolderKanban, FolderPlus, FolderUp, HardDrive, Link2, Pencil, RefreshCw, Trash2, Unlink } from "lucide-react";
import type { Folder } from "../../api";
import { askText } from "../../Confirm";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useFolders, useProjects, useStorage } from "../../data";
import { DRAG_TIMELINE, DRAG_TYPE } from "../../dragging";
import { size } from "../../format";
import { useFolderImport } from "../../folderImport";
import { useProject } from "../../project";
import type { Place } from "../../store";
import { cx, ErrorNote, TwoStep } from "../../ui";
import { foldersOf, tree } from "./tree";
import { useFolderMutations } from "./useFolderMutations";

const row = (on: boolean, over: boolean) =>
  cx("flex h-[34px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left", on ? "bg-hover font-semibold text-ink-strong" : "text-ink hover:bg-raised", over && "outline outline-2 outline-accent");
const hoverButton = "flex h-6 w-6 items-center justify-center rounded-md bg-raised text-ink-2 hover:bg-hover hover:text-ink";

/** What makes a row a place to drop on: an item of the library, timelines, or files from the computer. */
type DropProps = { onDragOver(e: DragEvent): void; onDragLeave(): void; onDrop(e: DragEvent): void };

/** One folder: a place to go to and a place to drop on; on hover, rename, delete or unlink, rescan a folder of the disk. */
function FolderRow({ f, selected, over, drop, onOpen, onEdit, onDelete, onRescan, scanning, deleting, onDeleted, onCancelDelete, onMenu }: {
  f: Folder & { depth: number };
  selected: boolean;
  over: boolean;
  drop: DropProps;
  onOpen(): void;
  onEdit(): void;
  onDelete(): void;
  onRescan(): void;
  scanning: boolean;
  /** The delete (or unlink) is being asked for. */
  deleting: boolean;
  onDeleted(): void;
  onCancelDelete(): void;
  onMenu(e: React.MouseEvent): void;
}) {
  return (
    <div style={{ paddingLeft: f.depth * 16 }}>
      <div className="group relative" {...drop} onContextMenu={onMenu}>
        <button type="button" onClick={onOpen} className={row(selected, over)}>
          <span className="flex min-w-0 items-center gap-2">
            {/* a folder inside another one sits under it, with an arrow that says so */}
            {f.depth > 0 ? <CornerDownRight size={13} className="shrink-0 text-ink-3" /> : f.path ? <HardDrive size={14} className="shrink-0 text-ink-2" /> : <FolderIcon size={14} className="shrink-0 text-ink-2" />}
            <span className="truncate" data-tip={f.path ?? undefined}>{f.name}</span>
          </span>
          <span className="shrink-0 font-normal text-ink-2 group-hover:invisible">{f.count}</span>
        </button>
        <span className="absolute inset-y-0 right-1 hidden items-center gap-0.5 group-hover:flex">
          {f.path && (
            <button type="button" aria-label={`Rescan ${f.name}`} data-tip="Scan the folder on your disk again: what was added appears, what was removed is gone" disabled={scanning} onClick={onRescan} className={hoverButton}>
              <RefreshCw size={12} className={scanning ? "animate-spin" : undefined} />
            </button>
          )}
          {(!f.path || f.root) && (
            <button type="button" aria-label={`Rename ${f.name}`} data-tip="Rename" onClick={onEdit} className={hoverButton}>
              <Pencil size={12} />
            </button>
          )}
          {(!f.path || f.root) && (
            <button type="button" aria-label={f.path ? `Unlink ${f.name}` : `Delete ${f.name}`} data-tip={f.path ? "Unlink: nothing on your disk is touched" : "Delete: its items move to the parent folder"} onClick={onDelete} className={hoverButton}>
              {f.path ? <Unlink size={12} /> : <Trash2 size={12} />}
            </button>
          )}
        </span>
      </div>
      {deleting && (
        <div className="py-1 pl-1.5">
          <TwoStep open title={f.path ? `Unlink ${f.name}` : `Delete ${f.name}`} note={f.path ? "Nothing on your disk is touched." : "Its items move to the parent folder."} yes={f.path ? "Unlink" : "Delete"} onYes={onDeleted} onCancel={onCancelDelete} />
        </div>
      )}
      {selected && f.path && (
        // a folder of the disk: where it is
        <span className="block truncate py-1 pl-1.5 font-mono text-[11px] text-ink-3" data-tip={f.path}>{f.path}</span>
      )}
    </div>
  );
}

/** A name typed for a new folder, inside the open one or at the top; or the path of a folder of the disk to link. */
function NewFolderForm({ adding, inside, onSubmit, onDone }: { adding: "inside" | "top" | "link"; inside: string | undefined; onSubmit(name: string): void; onDone(): void }) {
  const [text, setText] = useState("");
  return (
    <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text.trim()); onDone(); }}>
      <input
        autoFocus
        aria-label={adding === "link" ? "Folder path on the disk" : "New folder name"}
        placeholder={adding === "link" ? "Folder path, for example D:\\images\\shoots" : adding === "inside" && inside ? `New folder name, inside ${inside}` : "New folder name"}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (!text.trim()) onDone(); }}
        className={cx("h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5", adding === "link" && "font-mono text-xs")}
      />
      {adding === "link" && <span className="px-1 text-xs text-ink-3">A folder the computer Afflatus runs on can read. Its images, videos and audio files show here and are used in place; nothing is copied. Press Enter.</span>}
    </form>
  );
}

/** The bin: a place to go to, emptied now when asked twice, and how much the library takes on the disk. */
function BinFooter({ on, row: binRow, onOpen, empty }: { on: boolean; row: (on: boolean) => string; onOpen(): void; empty: { mutate(): void; isPending: boolean } }) {
  const storage = useStorage();
  return (
    <>
      <div className="my-1 border-t border-line" />
      <button type="button" onClick={onOpen} className={binRow(on)}>
        <span className="flex items-center gap-2"><Trash2 size={14} /> Bin</span>
        {storage.data && storage.data.bin.count > 0 && <span className="shrink-0 font-normal text-ink-2">{storage.data.bin.count}</span>}
      </button>
      {storage.data && storage.data.bin.count > 0 && (
        <div className="flex flex-wrap items-center gap-1 py-1 pl-1.5">
          <TwoStep
            label={empty.isPending ? "Emptying…" : `Empty bin · ${size(storage.data.bin.bytes)}`}
            icon={<Trash2 size={12} />}
            title="Everything in the bin is erased now, files and all, instead of after its 7 days."
            note="This cannot be undone."
            yes={`Erase ${size(storage.data.bin.bytes)}`}
            disabled={empty.isPending}
            busy={empty.isPending}
            onYes={() => empty.mutate()}
            className="h-7 border-0 px-1.5 text-ink-2 hover:text-ink"
          />
        </div>
      )}
      {storage.data && (
        <Link href="/settings/storage" data-tip="Disk usage breakdown and how to free space: in Settings." className="px-2.5 pt-1 text-xs text-ink-2 hover:text-ink">
          {size(storage.data.total)} used
          {storage.data.idleTakes.bytes + storage.data.bin.bytes > 0 ? ` · ${size(storage.data.idleTakes.bytes + storage.data.bin.bytes)} could be freed` : ""}
        </Link>
      )}
    </>
  );
}

/** A quiet line of the panel that does something: a new folder, a link, an import. */
function Action({ icon, title, onClick, children }: { icon: ReactNode; title?: string; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" data-tip={title} onClick={onClick} className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-left text-ink-2 hover:bg-raised hover:text-ink">
      {icon} <span className="truncate">{children}</span>
    </button>
  );
}

/**
 * The folders, as a panel: everything, each folder in its place in the tree, what is not filed yet,
 * the bin. A folder is a place to go to and a place to drop things on; the open one can be renamed
 * and deleted here, and a new one is made inside it.
 */
export function FolderPanel({ place, onPlace, dragging }: { place: Place; onPlace(p: Place): void; /** Something is being dragged: the panel is there to drop it on a folder. */ dragging?: boolean }) {
  const folders = useFolders();
  const client = useQueryClient();
  // a new folder: inside the one that is open, or at the top; or a directory of the disk to link
  const [adding, setAdding] = useState<false | "inside" | "top" | "link">(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const selected = place.type === "folder" ? place.id : null;
  const m = useFolderMutations({ selected, onPlace });
  // the folders of the project the app looks at (the Inbox: those in none; All: every one)
  const project = useProject((s) => s.id);
  const scoped = foldersOf(folders.data?.items ?? [], project);
  const open = (folders.data?.items ?? []).find((f) => f.id === selected);
  // a whole folder of the computer, brought in with its sub-folders: into the folder that is open, or at the top
  const picker = useRef<HTMLInputElement>(null);
  const bringIn = useFolderImport((s) => s.start);
  // right-click on a folder: what its hover buttons do, and a folder inside it
  const folderMenu = useMenu<Folder>();
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  /** "Move to" another project: not for a project's own root folder (the project would be left without one), nor for a linked directory of the disk. */
  const known = new Set((folders.data?.items ?? []).map((x) => x.id));
  const moveItems = (f: Folder): MenuItem[] =>
    projects.length && !f.path && !projects.some((p) => p.folderId === f.id)
      ? [{ label: "Move to", icon: <FolderKanban size={14} />, note: "another project, with what is in it", items: [
          ...projects.map((p): MenuItem => {
            // a project whose root folder is gone: at the top, in the project
            const root = p.folderId && known.has(p.folderId) ? p.folderId : null;
            return { label: p.name, icon: <FolderKanban size={14} />, note: root ? "inside its root folder" : "at the top of it", disabled: f.projectId === p.id && (root ? f.parentId === root : f.parentId === null), run: () => m.toProject.mutate({ id: f.id, name: f.name, project: { id: p.id, name: p.name, folderId: root } }) };
          }),
          { label: "The Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: f.projectId === null && f.parentId === null, run: () => m.toProject.mutate({ id: f.id, name: f.name, project: null }) },
        ] }]
      : [];
  const folderItems = (f: Folder): MenuItem[] => [
    { label: "Open", icon: <FolderIcon size={14} />, run: () => onPlace({ type: "folder", id: f.id }) },
    ...(!f.path ? [{ label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => void askText({ title: `A folder inside ${f.name}`, value: "", placeholder: "Name", yes: "Make it" }).then((name) => name?.trim() && m.create.mutate({ name: name.trim(), parent: f.id })) }] : []),
    ...(!f.path || f.root ? [{ label: "Rename", icon: <Pencil size={14} />, run: () => setEditing({ id: f.id, text: f.name }) }] : []),
    ...moveItems(f),
    ...(f.path ? [{ label: "Rescan", icon: <RefreshCw size={14} />, note: "what changed on your disk", disabled: m.look.isPending, run: () => m.look.mutate(f.id) }] : []),
    ...(!f.path || f.root ? ["—" as const, f.path
      ? { label: "Unlink", icon: <Unlink size={14} />, danger: true, note: "nothing on your disk is touched", run: () => setDeleting(f.id) }
      : { label: "Delete", icon: <Trash2 size={14} />, danger: true, note: "its items move to the parent folder", run: () => setDeleting(f.id) }] : []),
  ];

  /** A row that items can be dropped on: an item of the library, or files from the computer. */
  const drop = (key: string, folder: string | null): DropProps => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) && !e.dataTransfer.types.includes(DRAG_TIMELINE) && !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e) => {
      e.preventDefault();
      setOver(null);
      const asset = e.dataTransfer.getData(DRAG_TYPE);
      const timelines = e.dataTransfer.getData(DRAG_TIMELINE);
      if (timelines) m.moveTimelines.mutate({ ids: timelines.split(",").filter(Boolean), folder });
      else if (asset) m.move.mutate({ asset, folder });
      else if (e.dataTransfer.files.length) m.bring.mutate({ files: [...e.dataTransfer.files], folder });
    },
  });
  const error = m.error ?? folders.error;

  return (
    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
      {dragging && <div className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-accent-ink">Drop on a folder to put it there</div>}
      {m.bring.isPending && <div className="rounded-lg bg-raised px-2.5 py-1.5 text-xs text-ink-2">Importing…</div>}
      <button type="button" onClick={() => onPlace({ type: "all" })} className={row(place.type === "all", over === "all")}>All</button>
      {tree(scoped).map((f) =>
        editing?.id === f.id ? (
          <form key={f.id} onSubmit={(e) => { e.preventDefault(); if (editing.text.trim()) m.rename.mutate({ id: f.id, name: editing.text.trim() }); setEditing(null); }} style={{ paddingLeft: f.depth * 14 }}>
            <input autoFocus aria-label="Folder name" value={editing.text} onChange={(e) => setEditing({ id: f.id, text: e.target.value })} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} className="h-[34px] w-full rounded-lg border border-accent bg-raised px-2.5" />
          </form>
        ) : (
          <FolderRow
            key={f.id}
            f={f}
            selected={selected === f.id}
            over={over === f.id}
            drop={drop(f.id, f.id)}
            onOpen={() => onPlace({ type: "folder", id: f.id })}
            onEdit={() => setEditing({ id: f.id, text: f.name })}
            onDelete={() => setDeleting(f.id)}
            onRescan={() => m.look.mutate(f.id)}
            scanning={m.look.isPending}
            deleting={deleting === f.id}
            onDeleted={() => { m.remove.mutate(f.id); setDeleting(null); }}
            onCancelDelete={() => setDeleting(null)}
            onMenu={(e) => folderMenu.open(e, f)}
          />
        ),
      )}
      {folderMenu.menu && <ContextMenu at={folderMenu.menu.at} label={`Folder ${folderMenu.menu.subject.name}`} items={folderItems(folderMenu.menu.subject)} onClose={folderMenu.close} />}
      <button type="button" onClick={() => onPlace({ type: "unfiled" })} className={row(place.type === "unfiled", over === "unfiled")} {...drop("unfiled", null)} data-tip="What is in no folder and no project. Drop here to take items out of their folder">Inbox</button>

      {adding ? (
        <NewFolderForm adding={adding} inside={open?.name} onSubmit={(name) => (adding === "link" ? m.link.mutate(name) : m.create.mutate({ name, parent: adding === "inside" ? selected : null }))} onDone={() => setAdding(false)} />
      ) : (
        <>
          {open && <Action icon={<CornerDownRight size={14} className="shrink-0" />} onClick={() => setAdding("inside")}>New folder inside {open.name}</Action>}
          <Action icon={<FolderPlus size={14} className="shrink-0" />} onClick={() => setAdding("top")}>{open ? "New top-level folder" : "New folder"}</Action>
          <Action icon={<Link2 size={14} className="shrink-0" />} title="A folder of the disk Afflatus runs on, shown here with its sub-folders. Its files are used in place, nothing is copied." onClick={() => setAdding("link")}>Link a local folder</Action>
        </>
      )}
      <Action icon={<FolderUp size={14} className="shrink-0" />} title="Every image, video and audio file in a folder of your computer is copied into the library, with its sub-folders" onClick={() => picker.current?.click()}>
        Import a folder{open ? ` into ${open.name}` : ""}
      </Action>
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

      <BinFooter on={place.type === "bin"} row={(on) => row(on, over === "bin")} onOpen={() => onPlace({ type: "bin" })} empty={m.empty} />
      <div className="px-2.5 pt-1 text-xs text-ink-3">Drag an image onto a folder to move it there: moving it by hand keeps it. What you generate while a folder is open lands in it, and still has a day to be kept.</div>
    </div>
  );
}
