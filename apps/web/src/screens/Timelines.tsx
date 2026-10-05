import { useEffect, useState, type MouseEvent } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, Pencil, Plus, Trash2 } from "lucide-react";
import { api, thumbUrl, type TimelineBrief } from "../api";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { useProjects, useTimelines } from "../data";
import { useProject } from "../project";
import { clock, when } from "../format";
import { Button, cx, Empty, ErrorNote } from "../ui";

/**
 * Every timeline of the project, newest first. A timeline is a video made of clips played one after the
 * other. A card opens on click; Ctrl + click and Shift + click select several, for one Delete; a right-click
 * gives Open, Rename and Delete; a name is renamed in place.
 */
export function Timelines() {
  const list = useTimelines();
  const client = useQueryClient();
  const [, go] = useLocation();
  const refresh = () => client.invalidateQueries({ queryKey: ["timelines"] });
  const create = useMutation({
    mutationFn: () => api.createTimeline(),
    onSuccess: (t) => {
      void refresh();
      go(`/timelines/${t.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.deleteTimeline(id);
    },
    onSuccess: () => {
      setSelected(new Set());
      setConfirm(null);
      void refresh();
    },
  });
  const rename = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.editTimeline(id, { name }), onSuccess: refresh });
  const items = list.data?.items ?? [];
  const project = useProject((s) => s.id);
  const projects = useProjects();
  const nameOf = (id: string | null) => (id ? projects.data?.items.find((p) => p.id === id)?.name ?? null : null);

  /** The cards picked with Ctrl or Shift; `anchor` is the last one clicked, where a Shift range starts. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  /** Which deletion is being confirmed: one timeline, or the selection. */
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const menu = useMenu<TimelineBrief>();

  // Escape drops the selection or the rename; Delete asks about the selection
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector("[role=menu]") || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
      if (e.key === "Escape") {
        setSelected(new Set());
        setConfirm(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
        e.preventDefault();
        setConfirm([...selected]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);

  /** A click with Ctrl or Shift selects instead of opening; it is caught before the link sees it. */
  const pick = (e: MouseEvent, t: TimelineBrief) => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && anchor) {
      const ids = items.map((x) => x.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(t.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected((s) => new Set([...s, ...ids.slice(lo, hi + 1)]));
    } else {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(t.id)) n.delete(t.id);
        else n.add(t.id);
        return n;
      });
      setAnchor(t.id);
    }
  };
  const menuItems = (t: TimelineBrief): MenuItem[] => {
    const many = selected.has(t.id) && selected.size > 1 ? [...selected] : null;
    return [
      { label: "Open", key: "Enter", run: () => go(`/timelines/${t.id}`) },
      { label: "Rename", key: "F2", icon: <Pencil size={13} />, run: () => setRenaming({ id: t.id, name: t.name }) },
      "—",
      { label: many ? `Delete ${many.length} timelines` : "Delete", key: "Del", icon: <Trash2 size={13} />, danger: true, note: "the videos stay in your library", run: () => setConfirm(many ?? [t.id]) },
    ];
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const was = items.find((t) => t.id === renaming.id)?.name;
    if (name && name !== was) rename.mutate({ id: renaming.id, name });
    setRenaming(null);
  };
  const confirmed = confirm?.map((id) => items.find((t) => t.id === id)).filter((t): t is TimelineBrief => Boolean(t)) ?? [];

  return (
    <div className="flex min-w-0 grow flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-3 px-5">
        <h1 className="text-base font-semibold">Timelines</h1>
        <span className="text-ink-2">Videos made of clips that follow each other.</span>
        <span className="grow" />
        <Button tone="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          <Plus size={15} strokeWidth={2.6} /> New timeline
        </Button>
      </header>
      <div className="min-h-0 grow overflow-y-auto px-5 pb-6">
        {(list.isError || create.isError || remove.isError || rename.isError) && <ErrorNote>{(list.error ?? create.error ?? remove.error ?? rename.error)?.message}</ErrorNote>}
        {list.isSuccess && !items.length && (
          <Empty title="No timeline yet">
            A timeline plays clips one after the other. Each clip can extend the previous clip, so the motion and the voices continue across the cut. Start with New timeline.
          </Empty>
        )}
        {(selected.size > 0 || confirm) && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-2 text-sm">
            {confirm ? (
              <>
                <span>
                  Delete {confirmed.length === 1 ? <span className="font-semibold">{confirmed[0]!.name}</span> : `${confirmed.length} timelines`}? The videos stay in your library.
                </span>
                <span className="grow" />
                <button type="button" onClick={() => remove.mutate(confirm)} disabled={remove.isPending} className="rounded-md bg-warn px-2.5 py-1 text-xs font-bold text-warn-on">Delete</button>
                <button type="button" onClick={() => setConfirm(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
              </>
            ) : (
              <>
                <span><span className="font-semibold">{selected.size}</span> selected <span className="text-ink-3">· Ctrl + click adds one, Shift + click a range, Esc clears</span></span>
                <span className="grow" />
                <Button size="sm" onClick={() => setConfirm([...selected])}><Trash2 size={13} /> Delete</Button>
                <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
              </>
            )}
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
          {items.map((t) => {
            const picked = selected.has(t.id);
            return (
              <div
                key={t.id}
                onClickCapture={(e) => pick(e, t)}
                onContextMenu={(e) => menu.open(e, t)}
                onDoubleClick={(e) => { e.preventDefault(); setRenaming({ id: t.id, name: t.name }); }}
                aria-selected={picked}
                className={cx("flex flex-col overflow-hidden rounded-[10px] border bg-panel", picked ? "border-accent ring-2 ring-accent/40" : "border-line")}
              >
                <Link href={`/timelines/${t.id}`} aria-label={`Open ${t.name}`} className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
                  {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
                </Link>
                <div className="flex items-center gap-2 py-2 pr-1.5 pl-3">
                  {renaming?.id === t.id ? (
                    <input
                      autoFocus
                      value={renaming.name}
                      aria-label="The timeline's name"
                      onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenaming(null);
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 grow rounded-md border border-accent bg-ground px-1.5 py-0.5 font-semibold outline-none"
                    />
                  ) : (
                    <Link href={`/timelines/${t.id}`} className="flex min-w-0 grow flex-col">
                      <span className="truncate font-semibold">{t.name}</span>
                      <span className="text-xs text-ink-2">
                        {t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}
                        {project === null && nameOf(t.projectId) ? <span className="text-ink-3"> · {nameOf(t.projectId)}</span> : ""}
                      </span>
                    </Link>
                  )}
                  <button type="button" aria-label={`Rename ${t.name}`} title="Rename (or double-click the card)" onClick={(e) => { e.stopPropagation(); setRenaming({ id: t.id, name: t.name }); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-ink">
                    <Pencil size={13} />
                  </button>
                  <button type="button" aria-label={`Delete ${t.name}`} title="Delete the timeline. Its videos stay in your library." onClick={(e) => { e.stopPropagation(); setConfirm([t.id]); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-ink">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on this timeline" items={menuItems(menu.menu.subject)} onClose={menu.close} />}
    </div>
  );
}
