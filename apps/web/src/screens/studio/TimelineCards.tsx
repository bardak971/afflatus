import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Check, Film, Folder as FolderIcon, FolderKanban, Pencil, Plus, Trash2, X } from "lucide-react";
import { Select } from "../../Select";
import { api, thumbUrl, type TimelineBrief, type TimelineLeaf } from "../../api";
import { ask, askText } from "../../Confirm";
import { ContextMenu, useMenu, type MenuHead, type MenuItem } from "../../ContextMenu";
import { useFolders, useProjects, useProjectsTree } from "../../data";
import { DRAG_TIMELINE, DRAG_TYPE } from "../../dragging";
import { clock, when } from "../../format";
import { plainKey } from "../../Keys";
import { useKeysHere } from "../../keys/here";
import { projectForNew } from "../../project";
import { Button, Chip, cx, Empty, ErrorNote } from "../../ui";
import type { Place } from "../Library";
import { chipsOf, factsOf, stripOf } from "./timelineCard";

// M: four to a row beside the form, five without it; S and L one more and one fewer
const CARD = { S: "minmax(250px,1fr)", M: "minmax(320px,1fr)", L: "minmax(440px,1fr)" } as const;
/** How tall a card's film strip is, by the cards' size. */
const STRIP_H = { S: "h-[72px]", M: "h-24", L: "h-32" } as const;
/** A clip with nothing rendered yet, in the strip. */
const HATCH = "repeating-linear-gradient(45deg, var(--color-raised) 0 6px, var(--color-panel) 6px 12px)";

/**
 * The timelines of the place that is open, as cards in the Studio's grid: a click opens one in the editor,
 * Ctrl or Shift + click picks several, a right-click gives Open, Rename, Move to a project and Delete,
 * F2 renames, Delete asks about what is picked. The last card is a dashed one that makes a new timeline
 * where the Studio is looking.
 */
export function TimelineCards({ timelines, ready, place, size = "M", searched = false }: {
  timelines: TimelineBrief[];
  ready: boolean;
  place: Place;
  /** The cards' size (the header's S · M · L). */
  size?: "S" | "M" | "L";
  /** The list is a search's: an empty one says so. */
  searched?: boolean;
}) {
  useKeysHere("timelines");
  const [, go] = useLocation();
  const client = useQueryClient();
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  // the size, unused takes and export of every timeline, from the Projects panel's tree (the same query, read once for all the cards)
  const tree = useProjectsTree("");
  const leaves = useMemo(() => new Map((tree.data?.groups ?? []).flatMap((g) => g.timelines.map((l) => [l.id, l] as const))), [tree.data]);
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
  /** The head of its menu: its name, length and clips; several picked: how many. */
  const headOf = (t: TimelineBrief): MenuHead =>
    picked.has(t.id) && picked.size > 1
      ? { title: `${picked.size} timelines` }
      : { title: t.name, thumb: t.cover ?? undefined, sub: <><span className="font-mono">{clock(t.durationMs)}</span> · {t.clips} clip{t.clips === 1 ? "" : "s"}</> };
  const error = create.error ?? rename.error ?? move.error ?? remove.error;

  return (
    <>
      {error && <ErrorNote>{error.message}</ErrorNote>}
      {ready && !timelines.length && searched && <Empty title="No timeline of that name" help="Clear the search, or open All in the folder list." />}
      {ready && !timelines.length && !searched && (
        <Empty
          title={place.type === "folder" ? "No timeline in this folder" : "No timeline yet"}
          help={place.type === "folder"
            ? "A timeline is listed in the folder its renders land in (its own, else its project's root). Open All to see every timeline of the project, or start one here."
            : "A timeline plays clips one after the other; a clip can extend the one before, so the motion and the voices go on across the cut. Start one with the card below, or with \"Start a timeline from it\" on a picture or a video."}
        />
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
          <Button size="sm" disabled={remove.isPending} data-tip="Delete them: the videos stay in your library (Del)" onClick={() => void removeSome([...picked])}><Trash2 size={13} /> Delete</Button>
          <button type="button" aria-label="Clear selection" data-tip="Clear selection (Esc)" onClick={() => setPicked(new Set())} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
        </div>,
        slot,
      )}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD[size]})` }}>
        {place.type !== "bin" && (
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || makeOf.isPending}
            data-tip="A new, empty timeline, in the project the rail looks at. Drop pictures or videos on it: a timeline of them, in that order"
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropOver(true); } }}
            onDragLeave={() => setDropOver(false)}
            onDrop={(e) => {
              const ids = e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean);
              setDropOver(false);
              if (!ids.length) return;
              e.preventDefault();
              makeOf.mutate(ids);
            }}
            className={cx("flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed text-ink-2 hover:border-accent hover:text-ink", dropOver ? "border-accent bg-accent-wash text-ink" : "border-line-strong")}
          >
            <Plus size={20} strokeWidth={2.2} />
            <span className="text-sm font-semibold">{makeOf.isPending ? "Making it…" : "New timeline"}</span>
            <span className="text-[11px] text-ink-3">or drop pictures and videos here</span>
          </button>
        )}
        {timelines.map((t) => (
          <TimelineCard key={t.id} t={t} leaf={leaves.get(t.id)} size={size} picked={picked.has(t.id)} anyPicked={picked.size > 0} folder={place.type === "all" ? folderName(t.folderId) : null} onClick={(e, tick) => click(e, t, tick)} onMenu={(e) => menu.open(e, t)} onDragStart={(e) => {
            // the picked ones go together when this one is among them
            const ids = picked.has(t.id) ? [...picked] : [t.id];
            e.dataTransfer.setData(DRAG_TIMELINE, ids.join(","));
            e.dataTransfer.effectAllowed = "move";
          }} onTick={() => setPicked((p) => { const n = new Set(p); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} />
        ))}
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on this timeline" head={headOf(menu.menu.subject)} items={items(menu.menu.subject)} onClose={menu.close} />}
    </>
  );
}

/**
 * One timeline as a card: a film strip of its clips in order, each as wide as it plays (a clip still to render hatched), its name
 * and when it changed, its facts, the chips of what needs doing, and the tick that picks it. The render estimate is asked only
 * for a card with clips to render, once it is on screen, so a long list asks for the few that are seen.
 */
function TimelineCard({ t, leaf, size, picked, anyPicked, folder, onClick, onMenu, onDragStart, onTick }: {
  t: TimelineBrief;
  /** Its size, unused takes and export (the projects tree's), once read. */
  leaf: TimelineLeaf | undefined;
  size: "S" | "M" | "L";
  picked: boolean;
  /** Something is picked: the ticks show on every card. */
  anyPicked: boolean;
  /** The folder it is listed in, when the list is every folder's. */
  folder: string | null;
  onClick(e: React.MouseEvent, tick: boolean): void;
  onMenu(e: React.MouseEvent): void;
  onDragStart(e: React.DragEvent): void;
  onTick(): void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen || !t.toRender) return;
    const watch = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setSeen(true); }, { rootMargin: "200px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen, t.toRender]);
  // learned from this machine's renders, none said when nothing is learned; a change of the timeline is a new key
  const estimate = useQuery({
    queryKey: ["timeline-estimate", t.id, t.toRender, t.updatedAt],
    queryFn: ({ signal }) => api.commandEstimate({ timeline: t.id }, { signal }),
    enabled: seen && Boolean(t.toRender),
    staleTime: 5 * 60_000,
  });
  const frames = stripOf(t);
  const chips = chipsOf(t, leaf, estimate.data?.ms);
  return (
    <div className="group relative">
      <a
        ref={ref}
        href={`/timelines/${t.id}`}
        onClick={(e) => onClick(e, false)}
        onContextMenu={onMenu}
        draggable
        onDragStart={onDragStart}
        aria-selected={picked}
        className={cx("flex h-full flex-col overflow-hidden rounded-2xl border bg-panel", picked ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong")}
      >
        {/* a film strip: the clips in order, each as wide as it plays, so what is in it and what is left show at a glance */}
        <span className={cx("flex shrink-0 gap-0.5 px-2 pt-2", STRIP_H[size])}>
          {frames.map((f) => (
            <span
              key={f.n}
              style={{ flexGrow: f.grow, backgroundImage: f.asset ? undefined : HATCH }}
              data-tip={f.asset ? `Clip ${f.n}` : `Clip ${f.n}: to render`}
              className="relative min-w-4 basis-0 overflow-hidden rounded-md bg-raised"
            >
              {f.asset && <img src={thumbUrl(f.asset)} alt="" loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
              <span data-stage className="absolute bottom-1 left-1 rounded bg-stage/70 px-1 font-mono text-[10px] leading-tight text-ink">{f.n}</span>
            </span>
          ))}
          {!frames.length && <span className="flex grow items-center justify-center rounded-md border border-dashed border-line-strong text-ink-3"><Film size={22} /></span>}
          {t.clips > frames.length && frames.length > 0 && <span className="flex shrink-0 items-center rounded-md bg-raised px-1.5 text-[11px] font-semibold text-ink-2" data-tip={`${t.clips - frames.length} more clips`}>+{t.clips - frames.length}</span>}
        </span>
        <span className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="grow truncate text-[15px] font-bold">{t.name}</span>
            <span className="shrink-0 text-xs text-ink-2">{when(t.updatedAt)}</span>
          </span>
          <span className="truncate text-[12.5px] text-ink-2">{factsOf(t, leaf)}</span>
          {/* what needs doing, the same figures as the Projects panel; the folder when the list is every folder's */}
          {(chips.length > 0 || folder !== null) && (
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11.5px] font-semibold">
              {chips.map((c) => <Chip key={c.label} tone={c.tone} tip={c.title}>{c.label}</Chip>)}
              {folder !== null && <span className="flex min-w-0 items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 font-normal text-ink-2"><FolderIcon size={10} className="shrink-0" /><span className="truncate">{folder}</span></span>}
            </span>
          )}
        </span>
      </a>
      <span
        role="checkbox"
        tabIndex={0}
        aria-checked={picked}
        aria-label={`Select ${t.name}`}
        data-tip="Select (also Ctrl + click; Shift + click selects the range)"
        onClick={(e) => onClick(e, true)}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onTick(); } }}
        className={cx(
          "absolute top-3.5 left-3.5 z-10 flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-[6px] transition-colors",
          picked ? "bg-accent text-accent-ink" : "border-[1.5px] border-white/80 bg-ground/60",
          !picked && !anyPicked && "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        {picked && <Check size={12} strokeWidth={3.5} />}
      </span>
    </div>
  );
}
