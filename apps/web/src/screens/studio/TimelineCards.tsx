import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Film, Folder as FolderIcon, FolderKanban, Pencil, Plus, Trash2, X } from "lucide-react";
import { Select } from "../../Select";
import { api, thumbUrl, type TimelineBrief } from "../../api";
import { ask, askText } from "../../Confirm";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useFolders, useProjects } from "../../data";
import { DRAG_TIMELINE, DRAG_TYPE } from "../../dragging";
import { clock, when } from "../../format";
import { plainKey } from "../../Keys";
import { projectForNew } from "../../project";
import { Button, cx, Empty, ErrorNote } from "../../ui";
import type { Place } from "../Library";

/**
 * The timelines of the place that is open, as cards in the Studio's grid: a click opens one in the editor,
 * Ctrl or Shift + click picks several, a right-click gives Open, Rename, Move to a project and Delete,
 * F2 renames, Delete asks about what is picked. The last card is a dashed one that makes a new timeline
 * where the Studio is looking.
 */
const CARD = { S: "minmax(190px,1fr)", M: "minmax(250px,1fr)", L: "minmax(360px,1fr)" } as const;
/** A card's film strip shows this many clips at most; the rest are a "+N". */
const STRIP = 8;

export function TimelineCards({ timelines, ready, place, size = "M", searched = false }: {
  timelines: TimelineBrief[];
  ready: boolean;
  place: Place;
  /** The cards' size (the header's S · M · L). */
  size?: "S" | "M" | "L";
  /** The list is a search's: an empty one says so. */
  searched?: boolean;
}) {
  const [, go] = useLocation();
  const client = useQueryClient();
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  const refresh = () => client.invalidateQueries({ queryKey: ["timelines"] });
  const create = useMutation({ mutationFn: () => api.createTimeline(undefined, projectForNew()), onSuccess: (t) => { void refresh(); go(`/timelines/${t.id}`); } });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editTimeline(v.id, { name: v.name }), onSuccess: () => void refresh() });
  const move = useMutation({ mutationFn: (v: { ids: string[]; project: string | null }) => Promise.all(v.ids.map((id) => api.editTimeline(id, { project: v.project, folder: null }))), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api.deleteTimeline(id))), onSuccess: () => { setPicked(new Set()); void refresh(); } });

  /** The cards picked with Ctrl or Shift; `anchor` is the last one clicked, where a Shift range starts. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const menu = useMenu<TimelineBrief>();
  // another place, another list: nothing is picked
  useEffect(() => setPicked(new Set()), [place]);

  const folderName = (id: string | null) => (id ? folderList.data?.items.find((f) => f.id === id)?.name ?? "Folder" : "Project root");
  const renameOne = async (t: TimelineBrief) => {
    const name = await askText({ title: "Rename the timeline", value: t.name, placeholder: "A name for it", yes: "Rename" });
    if (name && name !== t.name) rename.mutate({ id: t.id, name });
  };
  const removeSome = async (ids: string[]) => {
    const named = ids.map((id) => timelines.find((t) => t.id === id)?.name).filter(Boolean);
    const one = ids.length === 1;
    if (await ask({ title: one ? `Delete ${named[0] ?? "this timeline"}?` : `Delete ${ids.length} timelines?`, text: "The videos stay in your library; only the sequence goes.", yes: "Delete" })) remove.mutate(ids);
  };

  // Escape drops the selection; Delete asks about it; F2 renames the one picked
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!picked.size || !plainKey(e) || document.querySelector("[role=menu], [role=dialog][aria-modal=true]")) return;
      if (e.key === "Escape") setPicked(new Set());
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void removeSome([...picked]);
      } else if (e.key === "F2" && picked.size === 1) {
        const t = timelines.find((x) => x.id === [...picked][0]);
        if (t) void renameOne(t);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, timelines]);

  /** A click with Ctrl or Shift picks instead of opening; so does the tick on the card. */
  const click = (e: React.MouseEvent, t: TimelineBrief, tick = false) => {
    if (!tick && !(e.ctrlKey || e.metaKey || e.shiftKey) && !picked.size) return go(`/timelines/${t.id}`);
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && anchor) {
      const ids = timelines.map((x) => x.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(t.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setPicked((s) => new Set([...s, ...ids.slice(lo, hi + 1)]));
    } else {
      setPicked((s) => {
        const n = new Set(s);
        if (n.has(t.id)) n.delete(t.id);
        else n.add(t.id);
        return n;
      });
      setAnchor(t.id);
    }
  };
  // a folder of its project: where it is listed, and where its renders land
  const folderList = useFolders();
  const toFolder = useMutation({
    mutationFn: (v: { ids: string[]; folder: string | null }) => Promise.all(v.ids.map((id) => api.editTimeline(id, { folder: v.folder }))),
    onSuccess: () => client.invalidateQueries({ queryKey: ["timelines"] }),
  });
  // the header's slot for the selection bar (LibraryHeader), found once it is drawn
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("timeline-selection-slot")), []);
  const pickedProject = timelines.find((t) => picked.has(t.id))?.projectId;
  const pickedFolders = (folderList.data?.items ?? []).filter((x) => x.projectId === pickedProject && !x.path);
  // items dropped on the New timeline card: a timeline of them, in the order dragged
  const [dropOver, setDropOver] = useState(false);
  const makeOf = useMutation({
    mutationFn: async (ids: string[]) => {
      const t = await api.createTimeline(undefined, projectForNew());
      for (const id of ids) await api.addClip(t.id, { asset: id });
      return t;
    },
    onSuccess: (t) => { void client.invalidateQueries({ queryKey: ["timelines"] }); go(`/timelines/${t.id}`); },
  });
  const items = (t: TimelineBrief): MenuItem[] => {
    const many = picked.has(t.id) && picked.size > 1 ? [...picked] : [t.id];
    const some = many.length > 1 ? `${many.length} timelines` : "";
    const folders = (folderList.data?.items ?? []).filter((x) => x.projectId === t.projectId && !x.path);
    return [
      { label: "Open", key: "Enter", run: () => go(`/timelines/${t.id}`) },
      { label: "Rename", key: "F2", icon: <Pencil size={13} />, run: () => void renameOne(t) },
      ...(folders.length ? [{ label: some ? `Put ${some} in a folder` : "Put in a folder", icon: <FolderIcon size={14} />, note: "listed there; its renders land there", items: [
        ...folders.map((x): MenuItem => ({ label: x.name, icon: <FolderIcon size={14} />, disabled: many.every((id) => timelines.find((y) => y.id === id)?.folderId === x.id), run: () => toFolder.mutate({ ids: many, folder: x.id }) })),
        "—" as const,
        { label: "The project's root", icon: <FolderIcon size={14} />, run: () => toFolder.mutate({ ids: many, folder: null }) },
      ] }] : []),
      ...(projects.length
        ? [
            "—" as const,
            { label: some ? `Move ${some} to` : "Move to", icon: <FolderKanban size={14} />, note: "another project", items: [
            ...projects.map((p): MenuItem => ({ label: p.name, icon: <FolderKanban size={14} />, note: "its root folder", disabled: many.every((id) => timelines.find((x) => x.id === id)?.projectId === p.id), run: () => move.mutate({ ids: many, project: p.id }) })),
            { label: "The Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: many.every((id) => timelines.find((x) => x.id === id)?.projectId === null), run: () => move.mutate({ ids: many, project: null }) },
            ] },
          ]
        : []),
      "—" as const,
      { label: some ? `Delete ${some}` : "Delete", key: "Del", icon: <Trash2 size={13} />, danger: true, note: "the videos stay in your library", run: () => void removeSome(many) },
    ];
  };
  const error = create.error ?? rename.error ?? move.error ?? remove.error;

  return (
    <>
      {error && <ErrorNote>{error.message}</ErrorNote>}
      {ready && !timelines.length && searched && <Empty title="No timeline of that name">Nothing here matches the search. Clear it, or open All in the folder list.</Empty>}
      {ready && !timelines.length && !searched && (
        <Empty title={place.type === "folder" ? "No timeline in this folder" : "No timeline yet"}>
          {place.type === "folder"
            ? "A timeline is listed in the folder its renders land in (its own, else its project's root). Open All to see every timeline of the project, or start one here."
            : "A timeline plays clips one after the other. Each clip can extend the previous clip, so the motion and the voices continue across the cut. Start one with the card below, or with \"Start a timeline from it\" on a picture or a video."}
        </Empty>
      )}
      {picked.size > 0 && slot && createPortal(
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-accent bg-panel py-1 pr-1 pl-3">
          <span className="font-semibold whitespace-nowrap">{picked.size} selected</span>
          {picked.size < timelines.length && <button type="button" onClick={() => setPicked(new Set(timelines.map((t) => t.id)))} className="text-xs text-ink-2 underline hover:text-ink">select all {timelines.length}</button>}
          {pickedFolders.length > 0 && (
            <div className="w-44">
              <Select
                size="sm" label="Put the selected timelines in a folder" placeholder="Put in a folder" searchHint="Search folders" value=""
                onChange={(to) => toFolder.mutate({ ids: [...picked], folder: to === "__root__" ? null : to })}
                options={[...pickedFolders.map((x) => ({ value: x.id, label: x.name })), { value: "__root__", label: "The project's root" }]}
              />
            </div>
          )}
          <Button size="sm" disabled={remove.isPending} title="Delete them: the videos stay in your library (Del)" onClick={() => void removeSome([...picked])}><Trash2 size={13} /> Delete</Button>
          <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setPicked(new Set())} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
        </div>,
        slot,
      )}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD[size]})` }}>
        {place.type !== "bin" && (
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || makeOf.isPending}
            title="A new, empty timeline, in the project the rail looks at. Drop pictures or videos on it: a timeline of them, in that order"
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropOver(true); } }}
            onDragLeave={() => setDropOver(false)}
            onDrop={(e) => {
              const ids = e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean);
              setDropOver(false);
              if (!ids.length) return;
              e.preventDefault();
              makeOf.mutate(ids);
            }}
            className={cx("flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed text-ink-2 hover:border-accent hover:text-ink", dropOver ? "border-accent bg-accent-wash text-ink" : "border-line-strong")}
          >
            <Plus size={20} strokeWidth={2.2} />
            <span className="text-sm font-semibold">{makeOf.isPending ? "Making it…" : "New timeline"}</span>
            <span className="text-[11px] text-ink-3">or drop pictures and videos here</span>
          </button>
        )}
        {timelines.map((t) => (
          <div key={t.id} className="group relative">
          <a
            href={`/timelines/${t.id}`}
            onClick={(e) => click(e, t)}
            onContextMenu={(e) => menu.open(e, t)}
            draggable
            onDragStart={(e) => {
              // the picked ones go together when this one is among them
              const ids = picked.has(t.id) ? [...picked] : [t.id];
              e.dataTransfer.setData(DRAG_TIMELINE, ids.join(","));
              e.dataTransfer.effectAllowed = "move";
            }}
            aria-selected={picked.has(t.id)}
            className={cx("flex flex-col overflow-hidden rounded-[10px] border-2 bg-panel", picked.has(t.id) ? "border-accent" : "border-transparent outline outline-1 outline-line hover:outline-line-strong")}
          >
            {/* a film strip: a frame per clip, in order, so what is in it shows at a glance */}
            <span className="relative flex aspect-video gap-px overflow-hidden bg-ground text-ink-3">
              {(t.strip?.length ? t.strip : t.cover ? [t.cover] : []).slice(0, STRIP).map((id, i) => (
                <span key={i} className="relative min-w-0 flex-1 bg-raised">
                  {id ? <img src={thumbUrl(id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center text-[11px]">{i + 1}</span>}
                </span>
              ))}
              {!t.strip?.length && !t.cover && <span className="flex grow items-center justify-center bg-raised"><Film size={26} /></span>}
              {t.clips > STRIP && <span className="absolute right-1.5 bottom-1.5 rounded bg-ground/85 px-1.5 py-0.5 text-[11px] font-semibold text-ink">+{t.clips - STRIP}</span>}
            </span>
            <span className="flex flex-col gap-1 px-3 py-2">
              <span className="truncate font-semibold">{t.name}</span>
              <span className="truncate text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
              {/* what is left to do, or that nothing is; the folder when the list is every folder's */}
              <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] font-semibold">
                {(t.toRender ?? 0) > 0 && <span className="rounded bg-warn-wash px-1.5 py-0.5 text-warn-ink">{t.toRender} to render</span>}
                {(t.staleJoins ?? 0) > 0 && <span className="rounded bg-warn-wash px-1.5 py-0.5 text-warn-ink">{t.staleJoins} join{t.staleJoins === 1 ? "" : "s"} to redo</span>}
                {t.clips > 0 && !t.toRender && !t.staleJoins && <span className="rounded border border-good/40 px-1.5 py-0.5 text-good">Ready</span>}
                {place.type === "all" && <span className="flex min-w-0 items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-normal text-ink-2"><FolderIcon size={10} className="shrink-0" /><span className="truncate">{folderName(t.folderId)}</span></span>}
              </span>
            </span>
          </a>
          <span
            role="checkbox"
            tabIndex={0}
            aria-checked={picked.has(t.id)}
            aria-label={`Select ${t.name}`}
            title="Select (also Ctrl + click; Shift + click selects the range)"
            onClick={(e) => click(e, t, true)}
            onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setPicked((p) => { const n = new Set(p); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; }); } }}
            className={cx(
              "absolute top-2 left-2 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-[1.5px] text-[11px] font-bold",
              picked.has(t.id) ? "border-accent bg-accent text-accent-ink" : "border-white/80 bg-ground/60 text-transparent",
              !picked.has(t.id) && !picked.size && "opacity-0 group-hover:opacity-100 focus:opacity-100",
            )}
          >
            ✓
          </span>
          </div>
        ))}
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on this timeline" items={items(menu.menu.subject)} onClose={menu.close} />}
    </>
  );
}
