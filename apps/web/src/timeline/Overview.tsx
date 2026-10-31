import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { cutsAtJoin } from "@afflatus/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, type Clip, type Timeline } from "../api";
import { AudioPlayer } from "../AudioPlayer";
import { openProjects, useTimelineRequest } from "../bar/bridge";
import { useBanners } from "../store";
import { useEntities, useFolders, useProjects } from "../data";
import { FieldRow } from "../fields";

import { lookWords } from "../LookBar";
import { clock, plural, spell } from "../format";
import { Picker } from "../PictureField";
import { MicButton } from "../mic/MicRecord";
import { PartHead } from "../recipeForm/Part";
import { Select } from "../Select";
import { Button, Chip, CloseButton, cx, Failed, Help, SectionTitle, Segmented } from "../ui";
import { change, past } from "./lookDrift";
import { attention, attentionLine, canDismiss, dismissKey, fixAll, fixOf, fixWords, JOIN_HELP, planFix, plansToAsk, SHOWS, withPlans, type Act, type Fix, type JoinFigures, type Plan, type Row } from "./attention";

/** The rows of Needs attention set aside, per timeline, in this browser (see dismissKey). */
const useDismissed = create<{ by: Record<string, string[]>; set(timeline: string, keys: string[]): void }>()(
  persist((set) => ({ by: {}, set: (timeline, keys) => set((s) => ({ by: { ...s.by, [timeline]: keys } })) }), { name: "afflatus.attention-kept" }),
);
import { otherShape } from "./model";
import { Estimate } from "./estimate";
import { joinsOf as askJoins } from "./measures";
import { queryKeys } from "../queryKeys";

/** A quiet action in a card's head or row: accent words, no box. */
const quiet = "shrink-0 text-xs font-semibold text-accent hover:underline disabled:opacity-40";

/**
 * What Needs attention lists for a timeline, each row with the action that mends it, the rows set aside left out
 * (until their clips play another take); with the joins' figures it is worked out from, one request per clip that
 * flows on and has a take (cached a minute, as the tooltip's). Shared by the Overview and the folded column's
 * count: the same requests either way. `checking` while what it is worked out from is not all known yet (the clips' forms,
 * through `known`, and the joins' figures): a row listed then could be wrong, or missing.
 */
export function useAttention(t: Timeline, clips: Clip[], renderable: (c: Clip) => boolean, msOf: (c: Clip) => number | null, o: { why?(c: Clip): string | undefined; voiceless?(c: Clip): boolean; known?: boolean } = {}) {
  const joined = clips.filter((c, i) => i > 0 && c.joined === "continue" && c.take);
  const joinQueries = useQueries({
    // asked for together (timeline/measures.ts): one request for the timeline's joins, not one per clip
    queries: joined.map((c) => ({ queryKey: queryKeys.joins.ofTake(c.id, c.take!.id, c.take!.startMs, c.take!.endMs), queryFn: () => askJoins(c.id).then((items) => ({ items })), staleTime: 60_000 })),
  });
  const joinItems = new Map<string, JoinFigures | undefined>(joined.map((c, k) => [c.id, joinQueries[k]?.data?.items]));
  const joinsOf = new Map<string, number | null | undefined>(joined.map((c) => {
    const items = joinItems.get(c.id);
    return [c.id, items ? (items.find((j) => j.take === c.take!.id)?.in ?? null) : undefined];
  }));
  const listed = attention(clips, { joins: joinItems, renderable, msOf, misfit: (c) => otherShape(c, t) && !c.fill, why: o.why, voiceless: o.voiceless });
  // a join whose figures could not be read is not waited for: its row is left out, as before
  const checking = o.known === false || joinQueries.some((q) => q.isPending);
  const dismissed = useDismissed();
  const kept = new Set(dismissed.by[t.id] ?? []);
  const rows = listed.filter((r) => !(canDismiss(r) && kept.has(dismissKey(r, clips))));
  return { joined, joinsOf, listed, rows, kept, dismissed, checking };
}

/**
 * Needs a look in one amber line, for the Export and Finish dialogs (the same rows as the Overview's, from
 * useAttention), with a quiet "Fix all first" that closes the dialog and runs what Fix all would; "Show them" when
 * nothing listed has an action, which closes the dialog onto the Overview. Nothing while the checks run, or when all is well.
 */
export function AttentionNote({ timeline, clips, renderable, msOf, why, voiceless, known, onFixFirst }: {
  timeline: Timeline;
  clips: Clip[];
  renderable(c: Clip): boolean;
  msOf(c: Clip): number | null;
  why?(c: Clip): string | undefined;
  voiceless?(c: Clip): boolean;
  known?: boolean;
  /** The plan to run (null: only show Needs attention). */
  onFixFirst(plan: Omit<Fix, "ms"> | null): void;
}) {
  const { rows, checking } = useAttention(timeline, clips, renderable, msOf, { why, voiceless, known });
  if (checking || !rows.length) return null;
  const plan = planFix(rows, clips, msOf);
  return (
    <div role="status" className="m-pop flex items-center gap-2 rounded-lg border border-attention/35 bg-attention-wash px-3 py-1.5 text-sm text-attention-ink">
      <span className="min-w-0 grow">{attentionLine(rows, clips)}</span>
      <button type="button" onClick={() => onFixFirst(plan)} data-tip={plan ? fixWords(plan, clips) || undefined : "Closes this and shows Needs a look: what it lists has no action that mends it here."} className={quiet}>
        {plan ? "Fix all first" : "Show them"}
      </button>
    </div>
  );
}

/**
 * The timeline as a whole, shown while no clip is selected: what it is, what needs attention (each line
 * with its clips, which select the clip, and the action that mends it; Fix all runs them all), its music,
 * its cast and look.
 */
export function Overview({ timeline: t, aspect, clips, renderable, msOf, plan, why, voiceless, known, onVoice, onPick, onMusic, onCast, onFolder, onFix, rendering, picked, onRenderPicked, fold }: {
  /** The video's aspect ratio: the shapes to pick from, or the first clip rendered deciding. */
  /** `short`: what its switch says ("16:9"), where four words would not fit on one row of the panel. */
  aspect: { value: string; options: Array<{ value: string; label: string; short?: string; note?: string; detail?: string }>; onChange(value: string): void };
  timeline: Timeline;
  clips: Clip[];
  /** A video clip with its form filled, not already in the queue. */
  renderable(c: Clip): boolean;
  /** About how long a clip takes to render; null when nothing was learned yet. */
  msOf(c: Clip): number | null;
  /** The server's plan of the clips left to render, as the header's Render all says it: each render's time is said from it. */
  plan?: Plan;
  /** Why a clip cannot be rendered yet, when its form is still to fill. */
  why?(c: Clip): string | undefined;
  /** A Lip sync clip without its voice recording yet: a row of its own. */
  voiceless?(c: Clip): boolean;
  /** A Lip sync clip's voice, chosen from its row ("Choose a recording…"). */
  onVoice?(clip: string, asset: string): void;
  /** The clips' forms are known (their models, the setup, the settings): until then what can render is not. */
  known?: boolean;
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
  /** The column's fold button, at the end of the first row. */
  fold?: ReactNode;
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
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.timelines.one(t.id) }),
  });
  const { joined, joinsOf, listed, rows: own, kept, dismissed, checking } = useAttention(t, clips, renderable, msOf, { why, voiceless, known });
  /** The Lip sync clip whose voice is being chosen from its row, if any. */
  const [voicePick, setVoicePick] = useState<string | null>(null);
  const measured = clips.filter((c) => c.take?.renderMs);
  const renderMs = measured.reduce((sum, c) => sum + (c.take!.renderMs ?? 0), 0);
  const rendered = measured.length;
  const stills = clips.filter((c) => c.kind === "still").length;
  const videos = clips.length - stills;
  const cast = lookWords(t.look, entities.data?.items ?? []);
  const number = (id: string) => clips.findIndex((c) => c.id === id) + 1;

  // a join holds when its figure and the run-up's end both stay at ×3 or under (past SHOWS it shows)
  const carryOf = (c: Clip) => c.take?.measure?.handover ?? null;
  const badJoin = (c: Clip) => {
    const figure = joinsOf.get(c.id);
    const carry = carryOf(c);
    return (figure !== undefined && figure !== null && figure > SHOWS) || (carry !== null && carry > SHOWS) || cutsAtJoin(c.take);
  };
  const figured = joined.filter((c) => typeof joinsOf.get(c.id) === "number");
  const loading = joined.some((c) => joinsOf.get(c.id) === undefined);
  const worst = figured.reduce<Clip | null>((w, c) => (!w || joinsOf.get(c.id)! > joinsOf.get(w.id)! ? c : w), null);
  // how the faces hold (Face Match of the takes that play): a face holds within DRIFT.face of the timeline's closest one
  const faced = clips.filter((c) => c.take?.measure?.face != null);
  const faceOf = (c: Clip) => c.take!.measure!.face!;
  const bestFace = faced.length ? Math.max(...faced.map(faceOf)) : 0;
  const faceHolds = (c: Clip) => !past("face", change(faceOf(c), bestFace, 0.05));
  const worstFace = faced.reduce<Clip | null>((w, c) => (!w || faceOf(c) < faceOf(w) ? c : w), null);

  // what needs attention, one row each with the action that mends it (useAttention); Fix all once two rows or more have one
  const setAside = listed.length - own.length;
  // only the keys of rows still listed are kept: a take changed, its old key goes
  const dismiss = (r: Row) => dismissed.set(t.id, [...listed.filter((x) => kept.has(dismissKey(x, clips))).map((x) => dismissKey(x, clips)), dismissKey(r, clips)]);
  // each render's time as the header's Render all says it, the server's plan of those clips on Auto: the same clips
  // read the same time everywhere (their own times added up said ~4 min where the header said ~2)
  const summed = fixAll(own, clips, msOf);
  const toAsk = plansToAsk(own, summed, plan);
  const plans = useQueries({
    queries: toAsk.map((ids) => {
      const at = ids.map(number);
      return { queryKey: queryKeys.timelinePlanned(t.id, at, t.updatedAt), queryFn: ({ signal }: { signal: AbortSignal }) => api.commandEstimate({ timeline: t.id, clips: at }, { signal }), staleTime: 30_000 };
    }),
  });
  const { rows, fix } = withPlans(own, summed, plan, toAsk.map((ids, k) => ({ ids, ms: plans[k]?.data?.ms })));
  const run = (a: Act) => {
    const f = fixOf(a);
    if (f) onFix(f);
    else if (a.do === "open") onPick(a.clip);
    else if (a.do === "voice") setVoicePick(a.clip);
  };
  // the command bar's Fix all, taken once the joins are measured: Fix all as its button, or the one row's own action when it is
  // the only one with an action (the button shows from two)
  const asked = useTimelineRequest((r) => r.request);
  const say = useBanners((b) => b.push);
  useEffect(() => {
    if (asked?.do !== "fix-all" || asked.timeline !== t.id || checking || rendering) return;
    useTimelineRequest.getState().take()?.reply(null);
    const one = rows.filter((r) => r.act && fixOf(r.act));
    if (fix) onFix(fix);
    else if (one.length === 1) run(one[0]!.act!);
    else say({ id: `bar-fix:${Date.now()}`, tone: "good", title: `${t.name}: nothing to fix`, text: rows.length ? "What Needs a look lists has no action that mends it." : undefined, href: `/timelines/${t.id}`, go: "Open the timeline" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request: the rest is read as it stands then
  }, [asked, checking, rendering]);
  const landsIn = folder && folder.id !== project?.folderId ? folder.name : project?.name ?? "the Inbox";
  const shapeWords = aspect.value === "first" ? "Shape from the first clip" : aspect.options.find((o) => o.value === aspect.value)?.label;
  const castWords = [cast, t.mood].filter(Boolean).join(" · ");
  // each value waits for what it is read from: a look names people and a style the kit has not sent yet, a folder the
  // folders' list; "nobody cast" (most timelines' real value) or "the Inbox" said before then would read as lost data
  const castKnown = !(t.look && (t.look.cast.length || t.look.style)) || Boolean(entities.data);
  const placeKnown = (!t.projectId || Boolean(projects.data)) && ((!t.folderId && !project?.folderId) || Boolean(folders.data));

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {/* its length is in the editor's header: not said twice */}
        <Chip>{`${plural(clips.length, "clip")}${stills ? ` · ${plural(stills, "still")}` : ""}`}</Chip>
        <Chip className={t.width && t.height ? "font-mono" : undefined}>{t.width && t.height ? `${t.width}×${t.height}` : "frame from the first clip"}</Chip>
        {project && (
          <Chip tone="link" tip="Show in Projects" onClick={() => openProjects(project.name)}>
            {project.name} <ChevronRight size={12} className="-ml-1" />
          </Chip>
        )}
        {fold && <span className="ml-auto">{fold}</span>}
      </div>

      {checking ? (
        // the checks still running (the forms, the joins' figures): the card's shape, not a count that grows under the pointer
        <section aria-busy="true" aria-label="Checking the clips and their joins" className="flex flex-col gap-2.5 rounded-xl border border-line px-3 py-2.5 shadow-card">
          <PartHead>Needs a look</PartHead>
          <span className="m-skeleton h-4 w-3/4" />
          <span className="m-skeleton h-4 w-1/2" />
        </section>
      ) : rows.length > 0 ? (
        // amber: something to look at, not something that failed (a failed render's row says it in red); the rows'
        // buttons all of one weight, Fix all leading them in the head
        <section className="m-pop flex flex-col rounded-xl border border-attention/35 bg-attention-wash pb-1.5">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-attention" />
            <SectionTitle className="grow text-attention-ink!">Needs a look · {rows.length}</SectionTitle>
            {fix && (
              <Button size="sm" disabled={rendering} onClick={() => onFix(fix)} data-tip={fixWords(fix, clips)}>
                Fix all{fix.ms > 0 && <Estimate ms={fix.ms} />}
              </Button>
            )}
          </div>
          {rows.map((r) => (
            <div key={r.key} className="flex min-h-[34px] items-center gap-1.5 px-3 py-1">
              <span className={cx("flex min-w-0 grow flex-wrap items-center gap-x-1.5 text-sm", r.kind === "failed" ? "text-warn-ink" : r.warn ? "text-attention-ink" : "text-ink")}>
                {LABEL[r.kind]}
                {/* which clips, said in words with links ("clip 5", "clips 2, 3"): a boxed number beside the row read as a count */}
                <span className="text-xs text-ink-3">·</span>
                <span className="text-xs text-ink-2">
                  {r.ids.length === 1 ? "clip " : "clips "}
                  {r.ids.slice(0, 8).map((id, k) => (
                    <span key={id}>
                      {k > 0 && ", "}
                      <button type="button" onClick={() => onPick(id)} data-tip={`Open clip ${number(id)}`} className="font-semibold text-accent underline-offset-2 hover:underline">{number(id)}</button>
                    </span>
                  ))}
                  {r.ids.length > 8 && ` and ${r.ids.length - 8} more`}
                  {r.figure !== undefined && <span className="ml-1 font-mono text-micro" data-tip={`At the join the picture changes up to ×${r.figure.toFixed(1)} its own motion from frame to frame (the run-up's end counted too). Past ×${SHOWS} the join shows.`}>×{times(r.figure)} motion</span>}
                </span>
                {r.reasons && <Help title={r.reasons.length === 1 ? "Why it failed" : "Why they failed"} text={r.reasons.map((x) => (r.reasons!.length === 1 ? x.why : `Clip ${number(x.clip)}: ${x.why}`)).join("\n")} />}
              </span>
              {/* the action and its × wrap together, under the words, never the × alone on a line */}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {r.act && <ActButton act={r.act} kind={r.kind} disabled={rendering} onClick={() => run(r.act!)} />}
                {/* the clip's Recording, recorded from the microphone: placed as one chosen is */}
                {r.act?.do === "voice" && onVoice && <VoiceMic clip={r.act.clip} onVoice={onVoice} />}
                {canDismiss(r) && (
                  <CloseButton size={28} label="Hide this row" tip="Hide this row: nothing changes on the timeline, and it is not listed again until its clips play another take" onClose={() => dismiss(r)} className="-mr-1.5 text-ink-3" />
                )}
              </span>
            </div>
          ))}
          {setAside > 0 && <ShowAgain n={setAside} onClick={() => dismissed.set(t.id, [])} />}
        </section>
      ) : (
        <section className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2.5 shadow-card">
          <PartHead>Needs a look</PartHead>
          <span className="text-sm text-good">{setAside ? "Nothing else: the rest is hidden." : "Every clip is rendered and every join holds."}</span>
          {setAside > 0 && <ShowAgain n={setAside} onClick={() => dismissed.set(t.id, [])} />}
        </section>
      )}

      <section className="flex flex-col rounded-xl border border-line-strong shadow-card">
        <div className="flex flex-col gap-0.5 border-b border-line px-3 py-2.5">
          <PartHead>Timeline</PartHead>
          {castKnown && placeKnown ? (
            <span className="truncate font-bold text-ink">{[shapeWords, cast || "nobody cast", `lands in ${landsIn}`].filter(Boolean).join(" · ")}</span>
          ) : (
            <span aria-hidden className="m-skeleton my-0.5 h-[18px] w-3/5" />
          )}
        </div>
        <div className="flex flex-col px-3 pt-1 pb-2.5 text-ink">
          <FieldRow label="Aspect" note={t.width && t.height ? `The video is ${t.width} × ${t.height}; every clip is made to fit it.` : "The first clip that is rendered decides; pick one to decide yourself."}>
            {aspect.options.length <= 4 ? (
              <Segmented
                size="sm"
                label="Aspect ratio"
                value={aspect.value}
                onChange={aspect.onChange}
                // "Auto", the long form in its tip: four short labels hold one row in the column at 1280 px too ("Clip 1" wrapped)
                options={aspect.options.map((o) => ({ value: o.value, label: o.value === "first" ? "Auto" : o.short ?? o.label, tip: o.value === "first" ? `Auto: as clip 1${o.detail ? `. ${o.detail}` : ""}` : o.detail ?? (o.note ? `${o.label} · ${o.note}` : undefined) }))}
              />
            ) : (
              <Select size="sm" label="Aspect ratio" value={aspect.value} onChange={aspect.onChange} options={aspect.options} />
            )}
          </FieldRow>
          <FieldRow label="Cast and look" note="Who is in the video, its style and a few mood words, set once for every clip: the people's reference pictures and LoRAs, and the words added to each clip's prompt. A clip given its own cast and look keeps it; changes apply from the next take.">
            <span className="flex min-w-0 items-center gap-1.5">
              {castKnown ? (
                <Chip truncate tip={castWords || undefined}>{castWords || "Nobody cast, no mood"}</Chip>
              ) : (
                <span aria-label="Loading the cast" className="m-skeleton h-6 w-28 rounded-full!" />
              )}
              <span className="grow" />
              <button type="button" onClick={onCast} className={quiet}>Change</button>
            </span>
          </FieldRow>
          <FieldRow label="Renders land in" note={fromClips ? "Taken from the first picture or clip you put here. Pick another to decide yourself." : "Every take and export of this timeline goes there."}>
            {!placeKnown ? <span aria-label="Loading the folders" className="m-skeleton block h-8 w-full" /> : <Select
              size="sm"
              label="Where the renders and exports of this timeline land"
              value={folder && folder.id !== project?.folderId ? folder.id : ""}
              onChange={(id) => onFolder(id || null)}
              options={[{ value: "", label: project ? `${project.name} (its root)` : "The Inbox" }, ...choices.map((f) => ({ value: f.id, label: pathOf(f.id), note: `${f.count}` }))]}
            />}
          </FieldRow>
          {elsewhere.length > 0 && (
            <span className="flex flex-wrap items-center gap-2 pt-1 text-xs text-ink-2">
              {elsewhere.length === 1 ? "1 take sits in another folder." : `${elsewhere.length} takes sit in other folders.`}
              <Button size="sm" disabled={gather.isPending} onClick={() => gather.mutate()} data-tip="Move those videos into this folder in the library. Nothing on the timeline changes.">{gather.isPending ? "Moving…" : "Move them here"}</Button>
              {gather.isError && <Failed inline what="Not moved" error={gather.error} />}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col rounded-xl border border-line-strong shadow-card">
        <div className={cx("flex items-center gap-2.5 px-3 py-2.5", t.music && "border-b border-line")}>
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <PartHead>Music</PartHead>
            <span className={cx("truncate", t.music ? "font-bold text-ink" : "text-sm text-ink-2")}>{t.music ? `${t.music.asset.name || "Music"} · ${t.music.volume} %${t.music.fromMs ? ` · from ${clock(t.music.fromMs, { decimals: 1 })}` : ""}${t.music.startClip && t.clips.findIndex((c) => c.id === t.music!.startClip) > 0 ? ` · starts with clip ${t.clips.findIndex((c) => c.id === t.music!.startClip) + 1}` : ""}${t.music.duck ? " · ducks under voices" : ""}` : "None: drop a sound on the Music track."}</span>
          </span>
          {t.music && <button type="button" onClick={onMusic} className={quiet}>Settings</button>}
        </div>
        {t.music && <AudioPlayer bare asset={t.music.asset.id} className="px-3 py-2.5" />}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-3 py-2.5 shadow-card">
        <PartHead>Joins and renders</PartHead>
        {(loading || figured.length > 0 || renderMs > 0 || faced.length > 1) && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {/* while the joins are measured their two facts keep their place as shapes: a count of some of them would be wrong */}
            {loading ? (
              <>
                <Fact label="Joins that hold" />
                <Fact label="Worst join" />
              </>
            ) : (
              <>
                {figured.length > 0 && <Fact label="Joins that hold" value={`${figured.filter((c) => !badJoin(c)).length} of ${figured.length}`} />}
                {worst && <Fact label="Worst join" value={`clip ${number(worst.id)} · join ×${joinsOf.get(worst.id)!.toFixed(1)}`} look={joinsOf.get(worst.id)! > SHOWS} help={JOIN_HELP} />}
              </>
            )}
            {faced.length > 1 && <Fact label="Faces that hold" value={`${faced.filter(faceHolds).length} of ${faced.length}`} tip="Face Match of the takes that play: a face holds within a fifth of the timeline's closest one" />}
            {faced.length > 1 && worstFace && <Fact label="Worst face" value={`clip ${number(worstFace.id)} · ${faceOf(worstFace).toFixed(2)}`} look={!faceHolds(worstFace)} />}
            {renderMs > 0 && <Fact label="Rendered in" value={spell(renderMs)} />}
            {renderMs > 0 && <Fact label="Measured" value={`${rendered} of ${plural(videos, "clip")}`} />}
          </div>
        )}
        {/* the chain's health at a glance: the largest frame-to-frame change at each join as it plays, fade included (×1 = the clip's own motion; past ×3 it shows) */}
        {joined.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {joined.map((c) => {
              const i = clips.findIndex((x) => x.id === c.id);
              const figure = joinsOf.get(c.id);
              const jumped = figure !== undefined && figure !== null && figure > SHOWS;
              // where the clip's own frames begin after the run-up: a model that steps away from its guide shows a cut there
              const carry = carryOf(c);
              const broke = carry !== null && carry > SHOWS;
              const bad = jumped || broke;
              return (
                <button key={c.id} type="button" onClick={() => onPick(c.id)} data-tip={`Clip ${i + 1}: as it comes in from clip ${i}, with its fade, the picture changes up to ×${figure?.toFixed(1) ?? "?"} its own motion from frame to frame${jumped ? `. Past ×${SHOWS} the join shows` : ""}${carry !== null ? `; where its own frames begin after the run-up, ×${carry.toFixed(1)}${broke ? ": a cut there, the model stepped away from its guide" : ""}` : ""}`} className={cx("rounded-md border px-1.5 py-px font-mono text-xs hover:border-accent", bad ? "border-attention/60 bg-attention-wash text-attention-ink" : "border-line-strong text-ink-2 hover:text-ink")}>
                  clip {i + 1} · join {figure === undefined ? <span aria-label="measuring" className="m-skeleton inline-block h-3 w-7 align-[-1px] rounded-sm!" /> : figure === null ? "–" : `×${figure.toFixed(1)}`}{broke && ` · end ×${carry.toFixed(1)}`}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-sm text-ink-2">No clip flows on from another yet.</span>
        )}
        {picked.size > 0 && <span className="pt-1"><Button size="sm" tone="primary" disabled={rendering} onClick={onRenderPicked}>Render {picked.size} picked</Button></span>}
      </section>
      {/* the picker the clip's Recording field opens */}
      {voicePick && (
        <Picker
          title="Recording"
          kind="audio"
          onClose={() => setVoicePick(null)}
          onPick={(asset) => {
            onVoice?.(voicePick, asset);
            setVoicePick(null);
          }}
        />
      )}
    </>
  );
}

/** The 🎙 of a Lip sync clip's row that waits for its Recording. */
function VoiceMic({ clip, onVoice }: { clip: string; onVoice(clip: string, asset: string): void }) {
  return <MicButton slot="Recording" onTake={(asset) => onVoice(clip, asset)} />;
}

/** One figure of the facts grid: a dim label over its value (amber when it needs a look); a shape of the value's size while it is not known. */
function Fact({ label, value, look, tip, help }: { label: string; value?: string; look?: boolean; tip?: string; /** What its figure measures, behind a ? beside its label. */ help?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-px" data-tip={tip}>
      <span className="flex items-center gap-1 text-meta text-ink-3">{label}{help && <Help title={label} text={help} />}</span>
      {value === undefined ? <span className="m-skeleton my-[3px] h-[18px] w-20" /> : <span className={cx("truncate font-mono", look ? "text-attention-ink" : "text-ink")}>{value}</span>}
    </span>
  );
}

/** A join's figure on its row: "×20" past ten, where the tenth says nothing, "×4.8" under. */
const times = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

/** The rows hidden with their ×, said at the foot of Needs a look: a click lists them again. */
function ShowAgain({ n, onClick }: { n: number; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="self-start px-3 pt-1 text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline">
      {n} hidden · show
    </button>
  );
}

/** What each row of Needs a look says. */
const LABEL: Record<Row["kind"], string> = {
  missing: "Not rendered yet",
  voice: "Needs a voice recording",
  stale: "Clip before changed",
  failed: "Failed",
  join: "Join jumps",
  shape: "Another aspect ratio",
};

/** A row's action, all of one weight: the row's colour says how much it matters, the button only what it does. */
function ActButton({ act, kind, disabled, onClick }: { act: Act; kind: Row["kind"]; disabled: boolean; onClick(): void }) {
  const n = act.do === "render" ? act.clips.length : 0;
  const [words, tip] =
    act.do === "take" ? [`Use take ${act.number}`, `Take ${act.number} comes in at ×${act.figure.toFixed(1)}: it plays instead (Undo puts the other back)`]
    : act.do === "fill" ? ["Fill the frame", `Crop ${act.clips.length === 1 ? "the clip" : `the ${act.clips.length} clips`} to the video's aspect ratio instead of bars (one Undo step each)`]
    // what the form waits for, said on the button ("Write prompt"); "Open" when the reason is not one short step
    : act.do === "voice" ? ["Choose a recording…", "The recording this clip is made around: the mouth follows it. Or drop one on the clip's Audio cell on the track"]
    : act.do === "open" ? [/^(Write|Choose) .{1,24} first\.$/.test(act.why) ? act.why.replace(/ first\.$/, "") : "Open", `${act.why} Opens the clip's form.`]
    : kind === "missing" ? [n === 1 ? "Render" : `Render ${n}`, n === 1 ? "Renders the clip, its first take" : `Renders the ${n} clips with no take yet, in order`]
    : kind === "stale" ? ["Render a new take", `A new take of ${n === 1 ? "the clip" : `the ${n} clips`}, from the clip before as it is now`]
    : kind === "failed" ? ["Retry", `Queues ${n === 1 ? "the clip" : `the ${n} clips`} again`]
    : ["Render a new take", `No other take comes in at ×${SHOWS} or under: render another`];
  return (
    <Button size="sm" disabled={disabled && act.do !== "open" && act.do !== "voice"} onClick={onClick} data-tip={tip}>
      {words}
      {act.do === "take" ? <span className="font-mono text-micro font-medium opacity-75">×{act.figure.toFixed(1)}</span> : act.do === "render" && act.ms > 0 && kind !== "failed" && <Estimate ms={act.ms} />}
    </Button>
  );
}
