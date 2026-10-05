import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { api, type Clip, type Timeline } from "../api";
import { useEntities, useFolders, useProjects } from "../data";
import { lookWords } from "../LookBar";
import { aboutMs, clock } from "../format";
import { Select } from "../Select";
import { Button, cx, SectionTitle } from "../ui";
import { otherShape } from "./model";

/**
 * The timeline as a whole, shown while no clip is selected: what it is, what needs attention (each line
 * selects the clip), its music, its cast and mood, and the two things done to the whole: render what is
 * missing, export.
 */
export function Overview({ timeline: t, aspect, clips, missing, misfits, allMs, onPick, onMusic, onCast, onFolder, onRenderAll, rendering, picked, onRenderPicked }: {
  /** The video's aspect ratio: the shapes to pick from, or the first clip rendered deciding. */
  aspect: { value: string; options: Array<{ value: string; label: string; note?: string; detail?: string }>; onChange(value: string): void };
  timeline: Timeline;
  clips: Clip[];
  missing: Clip[];
  misfits: number;
  allMs: number;
  onPick(clip: string): void;
  onMusic(): void;
  onCast(): void;
  /** Where its renders and exports land; null = the project's root (the Inbox when it has no project). */
  onFolder(folder: string | null): void;
  onRenderAll(): void;
  rendering: boolean;
  /** The clips picked with Ctrl + click on the track, rendered together. */
  picked: Set<string>;
  onRenderPicked(): void;
}) {
  const projects = useProjects();
  const folders = useFolders();
  const entities = useEntities();
  const project = t.projectId ? projects.data?.items.find((p) => p.id === t.projectId) : undefined;
  const folder = folders.data?.items.find((f) => f.id === (t.folderId ?? project?.folderId));
  // the folders it can land in: its project's (every folder when it has no project), each with where it sits
  const all = folders.data?.items ?? [];
  const pathOf = (id: string | null): string => {
    const f = all.find((x) => x.id === id);
    return f ? [pathOf(f.parentId), f.name].filter(Boolean).join(" / ") : "";
  };
  const choices = all.filter((f) => (t.projectId ? f.projectId === t.projectId : true) && f.id !== project?.folderId);
  const fromClips = Boolean(folder && !t.folderChosen && folder.id !== project?.folderId);
  // takes already made that sit in another folder than the timeline's: offered a move, never moved unasked
  const landing = t.folderId ?? project?.folderId ?? null;
  const elsewhere = clips.flatMap((c) => c.takes.map((x) => x.asset)).filter((a) => (a.folderId ?? null) !== landing);
  const client = useQueryClient();
  const gather = useMutation({
    mutationFn: () => api.moveAssets(elsewhere.map((a) => a.id), landing),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assets"] }).then(() => client.invalidateQueries({ queryKey: ["timelines", t.id] })),
  });
  const stale = clips.filter((c) => c.join === "stale");
  const failed = clips.filter((c) => c.failed && !c.take);
  // the joins' figures, one request per clip that flows on and has a take (cached a minute, as the tooltip's)
  const joined = clips.filter((c, i) => i > 0 && c.joined === "continue" && c.take);
  const joinQueries = useQueries({
    queries: joined.map((c) => ({ queryKey: ["joins", c.id, c.take!.id, c.take!.startMs, c.take!.endMs], queryFn: () => api.joins(c.id), staleTime: 60_000 })),
  });
  const joinsOf = new Map<string, number | null | undefined>(joined.map((c, k) => [c.id, joinQueries[k]?.data ? (joinQueries[k]!.data!.items.find((j) => j.take === c.take!.id)?.in ?? null) : undefined]));
  const measured = clips.filter((c) => c.take?.renderMs);
  const renderMs = measured.reduce((sum, c) => sum + (c.take!.renderMs ?? 0), 0);
  const rendered = measured.length;
  const wrong = clips.filter((c) => otherShape(c, t) && !c.fill);
  const stills = clips.filter((c) => c.kind === "still").length;
  const videos = clips.length - stills;
  const cast = lookWords(t.look, entities.data?.items ?? []);
  const row = (key: string, text: string, ids: string[], tone: "warn" | "plain" = "plain") => (
    <div key={key} className="flex flex-wrap items-center gap-1.5">
      <span className={cx("text-sm", tone === "warn" ? "text-warn-ink" : "text-ink")}>{text}</span>
      {ids.slice(0, 8).map((id) => {
        const i = clips.findIndex((c) => c.id === id);
        return <button key={id} type="button" onClick={() => onPick(id)} className="rounded-md border border-line-strong px-1.5 py-px font-mono text-xs text-ink-2 hover:border-accent hover:text-ink">{i + 1}</button>;
      })}
    </div>
  );
  return (
    <>
      <span className="text-xs">
        {[project?.name, `${clock(t.durationMs)}`, `${videos} clip${videos === 1 ? "" : "s"}${stills ? ` · ${stills} still${stills === 1 ? "" : "s"}` : ""}`, t.width && t.height ? `${t.width} × ${t.height}` : "frame from the first clip"].filter(Boolean).join(" · ")}
      </span>

      <section className="flex flex-col gap-1.5 rounded-xl border border-line bg-raised px-3.5 py-3">
        <SectionTitle>Needs attention</SectionTitle>
        {missing.length === 0 && stale.length === 0 && failed.length === 0 && wrong.length === 0 && <span className="text-sm text-good">Every clip is rendered and every join holds.</span>}
        {missing.filter((c) => !c.take).length > 0 && row("missing", `${missing.filter((c) => !c.take).length} not rendered yet`, missing.filter((c) => !c.take).map((c) => c.id))}
        {stale.length > 0 && row("stale", `${stale.length} join${stale.length === 1 ? "" : "s"} no longer hold${stale.length === 1 ? "s" : ""}: the clip before changed`, stale.map((c) => c.id), "warn")}
        {failed.length > 0 && row("failed", `${failed.length} failed to render`, failed.map((c) => c.id), "warn")}
        {wrong.length > 0 && row("shape", `${misfits} in another aspect ratio, shown with bars`, wrong.map((c) => c.id))}
        {missing.length > 0 && <span className="pt-1"><Button size="sm" tone="primary" disabled={rendering} onClick={onRenderAll}>Render all ({missing.length}){allMs ? ` · ${aboutMs(allMs)}` : ""}</Button></span>}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Music</SectionTitle>
        <div className="flex items-center gap-2">
          <span className="min-w-0 grow truncate text-sm text-ink">{t.music ? `${t.music.asset.name || "Music"} · ${t.music.volume} %${t.music.duck ? " · ducks under voices" : ""}` : "None: drop a sound on the Music track."}</span>
          {t.music && <Button size="sm" onClick={onMusic}>Settings</Button>}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Aspect ratio</SectionTitle>
        <Select size="sm" label="Aspect ratio" value={aspect.value} onChange={aspect.onChange} options={aspect.options} />
        <span className="text-xs text-ink-3">{t.width && t.height ? `The video is ${t.width} × ${t.height}; every clip is made to fit it.` : "The first clip that is rendered decides; pick one to decide yourself."}</span>
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Cast and mood</SectionTitle>
        <div className="flex items-center gap-2">
          <span className="min-w-0 grow truncate text-sm text-ink">{[cast, t.mood].filter(Boolean).join(" · ") || "Nobody yet, no mood set."}</span>
          <Button size="sm" onClick={onCast}>Change</Button>
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Renders land in</SectionTitle>
        <Select
          size="sm"
          label="Where the renders and exports of this timeline land"
          value={folder && folder.id !== project?.folderId ? folder.id : ""}
          onChange={(id) => onFolder(id || null)}
          options={[{ value: "", label: project ? `${project.name} (its root)` : "The Inbox, no folder" }, ...choices.map((f) => ({ value: f.id, label: pathOf(f.id), note: `${f.count}` }))]}
        />
        <span className="text-xs text-ink-3">{fromClips ? "Taken from the first picture or clip you put here. Pick another to decide yourself." : "Every take and export of this timeline goes there."}</span>
        {elsewhere.length > 0 && (
          <span className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            {elsewhere.length === 1 ? "1 take sits in another folder." : `${elsewhere.length} takes sit in other folders.`}
            <Button size="sm" disabled={gather.isPending} onClick={() => gather.mutate()} title="Move those videos into this folder in the library. Nothing on the timeline changes.">{gather.isPending ? "Moving…" : "Move them here"}</Button>
            {gather.isError && <span className="text-warn-ink">{gather.error.message}</span>}
          </span>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Joins and renders</SectionTitle>
        {/* the chain's health at a glance: how much the picture jumps at each join (×1 = the clip's own motion; past ×3 it shows), and what the renders cost */}
        {joined.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {joined.map((c) => {
              const i = clips.findIndex((x) => x.id === c.id);
              const figure = joinsOf.get(c.id);
              const jumped = figure !== undefined && figure !== null && figure > 3;
              // where the clip's own frames begin after the run-up: a model that steps away from its guide cuts there, not at the take-over point
              const carry = c.take?.measure?.handover ?? null;
              const broke = carry !== null && carry > 3;
              const bad = jumped || broke;
              return (
                <button key={c.id} type="button" onClick={() => onPick(c.id)} title={`Clip ${i + 1}: the picture jumps ×${figure?.toFixed(1) ?? "?"} its own motion where it takes over from clip ${i}${jumped ? ". Past ×3 the join shows" : ""}${carry !== null ? `; where its own frames begin after the run-up, ×${carry.toFixed(1)}${broke ? ": a cut there, the model stepped away from its guide" : ""}` : ""}`} className={cx("rounded-md border px-1.5 py-px font-mono text-xs hover:border-accent", bad ? "border-warn text-warn-ink" : "border-line-strong text-ink-2 hover:text-ink")}>
                  {i + 1}: {figure === undefined ? "…" : figure === null ? "–" : `×${figure.toFixed(1)}`}{broke && ` · end ×${carry.toFixed(1)}`}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-sm text-ink-2">No clip flows on from another yet.</span>
        )}
        {renderMs > 0 && <span className="text-xs text-ink-2">Rendered in {aboutMs(renderMs)} in all{rendered < videos ? ` (${rendered} of ${videos} clips measured)` : ""}.</span>}
        {picked.size > 0 && <span className="pt-1"><Button size="sm" tone="primary" disabled={rendering} onClick={onRenderPicked}>Render {picked.size} picked</Button></span>}
      </section>

      <span className="text-xs text-ink-3">Click a clip to work on it. Right-click one for its menu. I and O mark a range. Ctrl + click picks clips to render together.</span>
    </>
  );
}
