import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, X } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, type Clip, type Timeline } from "../api";
import { AudioPlayer } from "../AudioPlayer";
import { openProjects } from "../bar/bridge";
import { useEntities, useFolders, useProjects } from "../data";
import { FieldRow } from "../fields";
import { Kbd } from "../Keys";
import { lookWords } from "../LookBar";
import { aboutMs } from "../format";
import { PartHead } from "../recipeForm/Part";
import { Select } from "../Select";
import { Button, Chip, cx, Help, Segmented } from "../ui";
import { attention, canDismiss, dismissKey, fixAll, type Act, type Fix, type JoinFigures, type Row } from "./attention";

/** The rows of Needs attention set aside, per timeline, in this browser (see dismissKey). */
const useDismissed = create<{ by: Record<string, string[]>; set(timeline: string, keys: string[]): void }>()(
  persist((set) => ({ by: {}, set: (timeline, keys) => set((s) => ({ by: { ...s.by, [timeline]: keys } })) }), { name: "afflatus.attention-kept" }),
);
import { otherShape } from "./model";

/** A quiet action in a card's head or row: accent words, no box. */
const quiet = "shrink-0 text-xs font-semibold text-accent hover:underline disabled:opacity-40";

/** A render estimate as a button says it: "~7 min". */
const about = (ms: number) => aboutMs(ms).replace(/^about /, "~");

/**
 * The timeline as a whole, shown while no clip is selected: what it is, what needs attention (each line
 * with its clips, which select the clip, and the action that mends it; Fix all runs them all), its music,
 * its cast and mood.
 */
export function Overview({ timeline: t, aspect, clips, renderable, msOf, onPick, onMusic, onCast, onFolder, onFix, rendering, picked, onRenderPicked }: {
  /** The video's aspect ratio: the shapes to pick from, or the first clip rendered deciding. */
  aspect: { value: string; options: Array<{ value: string; label: string; note?: string; detail?: string }>; onChange(value: string): void };
  timeline: Timeline;
  clips: Clip[];
  /** A video clip with its form filled, not already in the queue. */
  renderable(c: Clip): boolean;
  /** About how long a clip takes to render; null when nothing was learned yet. */
  msOf(c: Clip): number | null;
  onPick(clip: string): void;
  onMusic(): void;
  onCast(): void;
  /** Where its renders and exports land; null = the project's root (the Inbox when it has no project). */
  onFolder(folder: string | null): void;
  /** Patches, then one render: a row's action, or all of them. */
  onFix(fix: Omit<Fix, "ms">): void;
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
    // the library hears of the move from the server (its library event); the timeline shows where its takes now are
    onSuccess: () => void client.invalidateQueries({ queryKey: ["timelines", t.id] }),
  });
  // the joins' figures, one request per clip that flows on and has a take (cached a minute, as the tooltip's)
  const joined = clips.filter((c, i) => i > 0 && c.joined === "continue" && c.take);
  const joinQueries = useQueries({
    queries: joined.map((c) => ({ queryKey: ["joins", c.id, c.take!.id, c.take!.startMs, c.take!.endMs], queryFn: () => api.joins(c.id), staleTime: 60_000 })),
  });
  const joinItems = new Map<string, JoinFigures | undefined>(joined.map((c, k) => [c.id, joinQueries[k]?.data?.items]));
  const joinsOf = new Map<string, number | null | undefined>(joined.map((c) => {
    const items = joinItems.get(c.id);
    return [c.id, items ? (items.find((j) => j.take === c.take!.id)?.in ?? null) : undefined];
  }));
  const measured = clips.filter((c) => c.take?.renderMs);
  const renderMs = measured.reduce((sum, c) => sum + (c.take!.renderMs ?? 0), 0);
  const rendered = measured.length;
  const stills = clips.filter((c) => c.kind === "still").length;
  const videos = clips.length - stills;
  const cast = lookWords(t.look, entities.data?.items ?? []);
  const number = (id: string) => clips.findIndex((c) => c.id === id) + 1;

  // a join holds when its figure and the run-up's end both stay at ×3 or under (past ×3 it shows)
  const carryOf = (c: Clip) => c.take?.measure?.handover ?? null;
  const badJoin = (c: Clip) => {
    const figure = joinsOf.get(c.id);
    const carry = carryOf(c);
    return (figure !== undefined && figure !== null && figure > 3) || (carry !== null && carry > 3);
  };
  const figured = joined.filter((c) => typeof joinsOf.get(c.id) === "number");
  const loading = joined.some((c) => joinsOf.get(c.id) === undefined);
  const worst = figured.reduce<Clip | null>((w, c) => (!w || joinsOf.get(c.id)! > joinsOf.get(w.id)! ? c : w), null);

  // what needs attention, one row each with the action that mends it; Fix all once two rows or more have one
  const listed = attention(clips, { joins: joinItems, renderable, msOf, misfit: (c) => otherShape(c, t) && !c.fill });
  // the ones set aside stay out, Fix all included, until their clips play another take
  const dismissed = useDismissed();
  const kept = new Set(dismissed.by[t.id] ?? []);
  const rows = listed.filter((r) => !(canDismiss(r) && kept.has(dismissKey(r, clips))));
  const setAside = listed.length - rows.length;
  // only the keys of rows still listed are kept: a take changed, its old key goes
  const dismiss = (r: Row) => dismissed.set(t.id, [...listed.filter((x) => kept.has(dismissKey(x, clips))).map((x) => dismissKey(x, clips)), dismissKey(r, clips)]);
  const fix = fixAll(rows, clips, msOf);
  const run = (a: Act) => onFix(a.do === "render" ? { patches: [], render: a.clips } : a.do === "take" ? { patches: [{ clip: a.clip, patch: { take: a.take } }], render: [] } : { patches: a.clips.map((clip) => ({ clip, patch: { fill: true } })), render: [] });
  const landsIn = folder && folder.id !== project?.folderId ? folder.name : project?.name ?? "the Inbox";
  const shapeWords = aspect.value === "first" ? "Shape from the first clip" : aspect.options.find((o) => o.value === aspect.value)?.label;
  const castWords = [cast, t.mood].filter(Boolean).join(" · ");

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {/* its length is in the editor's header: not said twice */}
        <Chip>{`${clips.length} clip${clips.length === 1 ? "" : "s"}${stills ? ` · ${stills} still${stills === 1 ? "" : "s"}` : ""}`}</Chip>
        <Chip className={t.width && t.height ? "font-mono" : undefined}>{t.width && t.height ? `${t.width}×${t.height}` : "frame from the first clip"}</Chip>
        {project && (
          <Chip tone="link" tip="Show in Projects" onClick={() => openProjects(project.name)}>
            {project.name} <ChevronRight size={12} className="-ml-1" />
          </Chip>
        )}
      </div>

      {rows.length > 0 ? (
        <section className="flex flex-col rounded-xl border border-warn/35 bg-warn-wash/60 pb-1.5">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <span className="grow text-[11px] font-bold tracking-[0.08em] text-warn-ink uppercase">Needs attention · {rows.length}</span>
            {fix && (
              <Button size="sm" tone="primary" disabled={rendering} onClick={() => onFix(fix)} data-tip={[fix.patches.length && `${fix.patches.length} clip change${fix.patches.length === 1 ? "" : "s"} (each its own Undo step)`, fix.render.length && `then ${fix.render.length} clip${fix.render.length === 1 ? "" : "s"} rendered, in order`].filter(Boolean).join(", ")}>
                Fix all{fix.ms > 0 && <Estimate ms={fix.ms} />}
              </Button>
            )}
          </div>
          {rows.map((r) => (
            <div key={r.key} className="flex min-h-[34px] flex-wrap items-center gap-1.5 px-3 py-1">
              <span className={cx("flex min-w-0 grow items-center gap-1.5 text-sm", r.warn ? "text-warn-ink" : "text-ink")}>
                {LABEL[r.kind]}
                {r.reasons && <Help title={r.reasons.length === 1 ? "Why it failed" : "Why they failed"} text={r.reasons.map((x) => (r.reasons!.length === 1 ? x.why : `Clip ${number(x.clip)}: ${x.why}`)).join("\n")} />}
              </span>
              {r.ids.slice(0, 8).map((id) => (
                <button key={id} type="button" onClick={() => onPick(id)} data-tip={`Clip ${number(id)}`} className="flex h-[22px] min-w-[22px] items-center justify-center rounded-[7px] border border-line-strong px-1.5 font-mono text-[11.5px] text-ink-2 hover:border-accent hover:text-ink">
                  {number(id)}{r.figure !== undefined && ` ×${r.figure.toFixed(1)}`}
                </button>
              ))}
              {r.act && <ActButton act={r.act} kind={r.kind} disabled={rendering} onClick={() => run(r.act!)} />}
              {canDismiss(r) && (
                <button type="button" aria-label="Keep as it is" data-tip="Keep as it is: not listed again until its clips play another take" onClick={() => dismiss(r)} className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink">
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {setAside > 0 && <ShowAgain n={setAside} onClick={() => dismissed.set(t.id, [])} />}
        </section>
      ) : (
        <section className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2.5">
          <PartHead>Needs attention</PartHead>
          <span className="text-sm text-good">{setAside ? "Nothing else: the rest is kept as it is." : "Every clip is rendered and every join holds."}</span>
          {setAside > 0 && <ShowAgain n={setAside} onClick={() => dismissed.set(t.id, [])} />}
        </section>
      )}

      <section className="flex flex-col rounded-xl border border-line-strong">
        <div className="flex flex-col gap-0.5 border-b border-line px-3 py-2.5">
          <PartHead>Timeline</PartHead>
          <span className="truncate font-bold text-ink">{[shapeWords, cast || "nobody cast", `lands in ${landsIn}`].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="flex flex-col px-3 pt-1 pb-2.5 text-ink">
          <FieldRow label="Aspect" note={t.width && t.height ? `The video is ${t.width} × ${t.height}; every clip is made to fit it.` : "The first clip that is rendered decides; pick one to decide yourself."}>
            {aspect.options.length <= 4 ? (
              <Segmented
                size="sm"
                label="Aspect ratio"
                value={aspect.value}
                onChange={aspect.onChange}
                options={aspect.options.map((o) => ({ value: o.value, label: o.value === "first" ? "First clip" : o.label, tip: o.detail ?? o.note }))}
              />
            ) : (
              <Select size="sm" label="Aspect ratio" value={aspect.value} onChange={aspect.onChange} options={aspect.options} />
            )}
          </FieldRow>
          <FieldRow label="Cast and mood" note="Who is in the video and a few words of look and mood, set once for every clip: the people's reference pictures and LoRAs, and the words added to each clip's prompt. A clip given its own keeps it; changes apply from the next take.">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-[26px] min-w-0 items-center rounded-full bg-hover px-2.5 text-[12.5px] font-semibold text-ink" data-tip={castWords || undefined}>
                <span className="truncate">{castWords || "Nobody yet, no mood set."}</span>
              </span>
              <span className="grow" />
              <button type="button" onClick={onCast} className={quiet}>Change</button>
            </span>
          </FieldRow>
          <FieldRow label="Renders land in" note={fromClips ? "Taken from the first picture or clip you put here. Pick another to decide yourself." : "Every take and export of this timeline goes there."}>
            <Select
              size="sm"
              label="Where the renders and exports of this timeline land"
              value={folder && folder.id !== project?.folderId ? folder.id : ""}
              onChange={(id) => onFolder(id || null)}
              options={[{ value: "", label: project ? `${project.name} (its root)` : "The Inbox" }, ...choices.map((f) => ({ value: f.id, label: pathOf(f.id), note: `${f.count}` }))]}
            />
          </FieldRow>
          {elsewhere.length > 0 && (
            <span className="flex flex-wrap items-center gap-2 pt-1 text-xs text-ink-2">
              {elsewhere.length === 1 ? "1 take sits in another folder." : `${elsewhere.length} takes sit in other folders.`}
              <Button size="sm" disabled={gather.isPending} onClick={() => gather.mutate()} data-tip="Move those videos into this folder in the library. Nothing on the timeline changes.">{gather.isPending ? "Moving…" : "Move them here"}</Button>
              {gather.isError && <span className="text-warn-ink">{gather.error.message}</span>}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col rounded-xl border border-line-strong">
        <div className={cx("flex items-center gap-2.5 px-3 py-2.5", t.music && "border-b border-line")}>
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <PartHead>Music</PartHead>
            <span className={cx("truncate", t.music ? "font-bold text-ink" : "text-sm text-ink-2")}>{t.music ? `${t.music.asset.name || "Music"} · ${t.music.volume} %${t.music.duck ? " · ducks under voices" : ""}` : "None: drop a sound on the Music track."}</span>
          </span>
          {t.music && <button type="button" onClick={onMusic} className={quiet}>Settings</button>}
        </div>
        {t.music && <AudioPlayer bare asset={t.music.asset.id} className="px-3 py-2.5" />}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-3 py-2.5">
        <PartHead>Joins and renders</PartHead>
        {(figured.length > 0 || renderMs > 0) && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {figured.length > 0 && <Fact label="Joins that hold" value={loading ? "…" : `${figured.filter((c) => !badJoin(c)).length} of ${figured.length}`} />}
            {worst && <Fact label="Worst join" value={`clip ${number(worst.id)} · ×${joinsOf.get(worst.id)!.toFixed(1)}`} warn={joinsOf.get(worst.id)! > 3} />}
            {renderMs > 0 && <Fact label="Rendered in" value={aboutMs(renderMs).replace(/^about /, "~")} />}
            {renderMs > 0 && <Fact label="Measured" value={`${rendered} of ${videos} clip${videos === 1 ? "" : "s"}`} />}
          </div>
        )}
        {/* the chain's health at a glance: the largest frame-to-frame change at each join as it plays, fade included (×1 = the clip's own motion; past ×3 it shows) */}
        {joined.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {joined.map((c) => {
              const i = clips.findIndex((x) => x.id === c.id);
              const figure = joinsOf.get(c.id);
              const jumped = figure !== undefined && figure !== null && figure > 3;
              // where the clip's own frames begin after the run-up: a model that steps away from its guide shows a cut there
              const carry = carryOf(c);
              const broke = carry !== null && carry > 3;
              const bad = jumped || broke;
              return (
                <button key={c.id} type="button" onClick={() => onPick(c.id)} data-tip={`Clip ${i + 1}: as it comes in from clip ${i}, with its fade, the picture changes up to ×${figure?.toFixed(1) ?? "?"} its own motion from frame to frame${jumped ? ". Past ×3 the join shows" : ""}${carry !== null ? `; where its own frames begin after the run-up, ×${carry.toFixed(1)}${broke ? ": a cut there, the model stepped away from its guide" : ""}` : ""}`} className={cx("rounded-md border px-1.5 py-px font-mono text-xs hover:border-accent", bad ? "border-warn text-warn-ink" : "border-line-strong text-ink-2 hover:text-ink")}>
                  {i + 1}: {figure === undefined ? "…" : figure === null ? "–" : `×${figure.toFixed(1)}`}{broke && ` · end ×${carry.toFixed(1)}`}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-sm text-ink-2">No clip flows on from another yet.</span>
        )}
        {picked.size > 0 && <span className="pt-1"><Button size="sm" tone="primary" disabled={rendering} onClick={onRenderPicked}>Render {picked.size} picked</Button></span>}
      </section>

      <div className="mt-auto flex flex-wrap gap-x-3.5 gap-y-1.5 border-t border-line pt-3 text-[11.5px] text-ink-3">
        <span className="flex items-center gap-1.5"><Kbd>Click</Kbd>a clip</span>
        <span className="flex items-center gap-1.5"><Kbd>I</Kbd><Kbd>O</Kbd>a range</span>
        <span className="flex items-center gap-1.5"><Kbd>Ctrl</Kbd>+ click picks clips</span>
      </div>
    </>
  );
}

/** One figure of the facts grid: a dim label over its value. */
function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-px">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <span className={cx("truncate font-mono", warn ? "text-warn-ink" : "text-ink")}>{value}</span>
    </span>
  );
}

/** The rows set aside, said at the foot of Needs attention: a click lists them again. */
function ShowAgain({ n, onClick }: { n: number; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="self-start px-3 pt-1 text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline">
      {n} kept as {n === 1 ? "it is" : "they are"} · show
    </button>
  );
}

/** What each row of Needs attention says. */
const LABEL: Record<Row["kind"], string> = {
  missing: "Not rendered yet",
  stale: "Clip before changed",
  failed: "Failed",
  join: "Join shows",
  shape: "Another aspect ratio",
};

/** A render estimate inside a button, dimmed. */
function Estimate({ ms }: { ms: number }) {
  return <span className="font-mono text-[11px] font-medium opacity-75">{about(ms)}</span>;
}

/** A row's action: quiet, or warn-washed where something went wrong (the clip before changed, a failed render). */
function ActButton({ act, kind, disabled, onClick }: { act: Act; kind: Row["kind"]; disabled: boolean; onClick(): void }) {
  const warn = kind === "stale" || kind === "failed";
  const n = act.do === "render" ? act.clips.length : 0;
  const [words, tip] =
    act.do === "take" ? [`Use take ${act.number}`, `Take ${act.number} comes in at ×${act.figure.toFixed(1)}: it plays instead (Undo puts the other back)`]
    : act.do === "fill" ? ["Fill the frame", `Crop ${act.clips.length === 1 ? "the clip" : `the ${act.clips.length} clips`} to the video's aspect ratio instead of bars (one Undo step each)`]
    : kind === "missing" ? [`Render ${n}`, `Renders the ${n} clip${n === 1 ? "" : "s"} with no take yet, in order`]
    : kind === "stale" ? ["Re-render", `A new take of ${n === 1 ? "the clip" : `the ${n} clips`}, from the clip before as it is now`]
    : kind === "failed" ? ["Retry", `Queues ${n === 1 ? "the clip" : `the ${n} clips`} again`]
    : ["New take", "No other take comes in under ×3: render another"];
  return (
    <Button size="sm" tone={warn ? "danger" : "quiet"} disabled={disabled} onClick={onClick} data-tip={tip}>
      {words}
      {act.do === "take" ? <span className="font-mono text-[11px] font-medium opacity-75">×{act.figure.toFixed(1)}</span> : act.do === "render" && act.ms > 0 && kind !== "failed" && <Estimate ms={act.ms} />}
    </Button>
  );
}
