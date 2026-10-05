import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Film, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import { api, thumbUrl, type TimelineBrief } from "../../api";
import { ask, askText } from "../../Confirm";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useProjects } from "../../data";
import { clock, when } from "../../format";
import { plainKey } from "../../Keys";
import { projectForNew } from "../../project";
import { cx, Empty, ErrorNote } from "../../ui";
import type { Place } from "../Library";

/**
 * The timelines of the place that is open, as cards in the Studio's grid: a click opens one in the editor,
 * Ctrl or Shift + click picks several, a right-click gives Open, Rename, Move to a project and Delete,
 * F2 renames, Delete asks about what is picked. The last card is a dashed one that makes a new timeline
 * where the Studio is looking.
 */
export function TimelineCards({ timelines, ready, place }: { timelines: TimelineBrief[]; ready: boolean; place: Place }) {
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

  /** A click with Ctrl or Shift picks instead of opening. */
  const click = (e: React.MouseEvent, t: TimelineBrief) => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey) && !picked.size) return go(`/timelines/${t.id}`);
    e.preventDefault();
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
  const items = (t: TimelineBrief): MenuItem[] => {
    const many = picked.has(t.id) && picked.size > 1 ? [...picked] : [t.id];
    const some = many.length > 1 ? `${many.length} timelines` : "";
    return [
      { label: "Open", key: "Enter", run: () => go(`/timelines/${t.id}`) },
      { label: "Rename", key: "F2", icon: <Pencil size={13} />, run: () => void renameOne(t) },
      ...(projects.length
        ? [
            "—" as const,
            ...projects.map((p): MenuItem => ({ label: `Move ${some || "it"} to ${p.name}`, icon: <FolderKanban size={14} />, note: "its root folder", disabled: many.every((id) => timelines.find((x) => x.id === id)?.projectId === p.id), run: () => move.mutate({ ids: many, project: p.id }) })),
            { label: `Move ${some || "it"} to the Inbox`, icon: <FolderKanban size={14} />, note: "out of every project", disabled: many.every((id) => timelines.find((x) => x.id === id)?.projectId === null), run: () => move.mutate({ ids: many, project: null }) },
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
      {ready && !timelines.length && (
        <Empty title={place.type === "folder" ? "No timeline in this folder" : "No timeline yet"}>
          {place.type === "folder"
            ? "A timeline is listed in the folder its renders land in (its own, else its project's root). Open All to see every timeline of the project, or start one here."
            : "A timeline plays clips one after the other. Each clip can extend the previous clip, so the motion and the voices continue across the cut. Start one with the card below, or with \"Start a timeline from it\" on a picture or a video."}
        </Empty>
      )}
      {picked.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-accent bg-panel px-3 py-1.5 text-sm">
          <span className="font-semibold">{picked.size} selected</span>
          <span className="grow" />
          <button type="button" onClick={() => void removeSome([...picked])} disabled={remove.isPending} className="rounded-md bg-warn px-2.5 py-1 text-xs font-bold text-warn-on">Delete</button>
          <button type="button" onClick={() => setPicked(new Set())} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
        {timelines.map((t) => (
          <a
            key={t.id}
            href={`/timelines/${t.id}`}
            onClick={(e) => click(e, t)}
            onContextMenu={(e) => menu.open(e, t)}
            aria-selected={picked.has(t.id)}
            className={cx("flex flex-col overflow-hidden rounded-[10px] border bg-panel hover:border-accent", picked.has(t.id) ? "border-accent ring-2 ring-accent/40" : "border-line")}
          >
            <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
              {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
            </span>
            <span className="flex flex-col px-3 py-2">
              <span className="truncate font-semibold">{t.name}</span>
              <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
            </span>
          </a>
        ))}
        {place.type !== "bin" && (
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending}
            title="A new, empty timeline, in the project the rail looks at"
            className="flex aspect-[230/180] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong text-ink-2 hover:border-accent hover:text-ink"
          >
            <Plus size={22} strokeWidth={2.2} />
            <span className="text-sm font-semibold">New timeline</span>
          </button>
        )}
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on this timeline" items={items(menu.menu.subject)} onClose={menu.close} />}
    </>
  );
}
