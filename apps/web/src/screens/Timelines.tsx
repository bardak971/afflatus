import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, Plus, Trash2 } from "lucide-react";
import { api, thumbUrl } from "../api";
import { useProjects, useTimelines } from "../data";
import { useProject } from "../project";
import { clock, when } from "../format";
import { Button, Empty, ErrorNote } from "../ui";

/** Every timeline, newest first. A timeline is a video made of clips played one after the other. */
export function Timelines() {
  const list = useTimelines();
  const client = useQueryClient();
  const [, go] = useLocation();
  const [deleting, setDeleting] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["timelines"] });
  const create = useMutation({
    mutationFn: () => api.createTimeline(),
    onSuccess: (t) => {
      void refresh();
      go(`/timelines/${t.id}`);
    },
  });
  const remove = useMutation({ mutationFn: api.deleteTimeline, onSuccess: refresh });
  const items = list.data?.items ?? [];
  const project = useProject((s) => s.id);
  const projects = useProjects();
  const nameOf = (id: string | null) => (id ? projects.data?.items.find((p) => p.id === id)?.name ?? null : null);

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
        {(list.isError || create.isError || remove.isError) && <ErrorNote>{(list.error ?? create.error ?? remove.error)?.message}</ErrorNote>}
        {list.isSuccess && !items.length && (
          <Empty title="No timeline yet">
            A timeline plays clips one after the other. Each clip can extend the previous clip, so the motion and the voices continue across the cut. Start with New timeline.
          </Empty>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
          {items.map((t) => (
            <div key={t.id} className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
              <Link href={`/timelines/${t.id}`} aria-label={`Open ${t.name}`} className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
                {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
              </Link>
              <div className="flex items-center gap-2 py-2 pr-1.5 pl-3">
                <Link href={`/timelines/${t.id}`} className="flex min-w-0 grow flex-col">
                  <span className="truncate font-semibold">{t.name}</span>
                  <span className="text-xs text-ink-2">
                    {t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}
                    {project === null && nameOf(t.projectId) ? <span className="text-ink-3"> · {nameOf(t.projectId)}</span> : ""}
                  </span>
                </Link>
                {deleting === t.id ? (
                  <>
                    <button type="button" onClick={() => { remove.mutate(t.id); setDeleting(null); }} className="rounded-md bg-warn px-2 py-1 text-xs font-bold text-warn-on">Delete</button>
                    <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-hover">Cancel</button>
                  </>
                ) : (
                  <button type="button" aria-label={`Delete ${t.name}`} title="Delete the timeline. Its videos stay in your library." onClick={() => setDeleting(t.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-ink">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
