import { CUT_WINDOW_MOST, cutAtJoinFigure, cutAtJoinSaid, cutsAtJoin, OWN_MODEL, plural, recordingSpecOf, TRANSITION_KINDS, TRANSITION_MS, type InputSpec, type Recipe } from "@afflatus/core";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { castOf, checkedValues } from "./mcpDrafts";
import { formOf, machineName, machineOf, seen, spends, wholeOf, type Seen } from "./mcpForms";
import { mayQueueAll } from "./mcpRender";
import { quoted, Rich, tool, type ToolCtx } from "./mcpTool";
import { rootFolderOf } from "./projects";
import type { Services } from "./services";
import { contactSheet } from "./thumbs";
import { exportBody, exportTimeline, finishBody, finishClips, finishPlan, maskPreview, maskPreviewOf, rangeAction, renderClips, timelineRangeBody } from "./timelines-api";
import { clockOf, CUT_JOB } from "./timelineModel";
import type { ClipPatch, TimelinePatch, Timelines } from "./timelines";

/**
 * The timelines, from outside (MCP): listed, read whole (clips, takes, joins, lanes, what needs a look), changed action by
 * action through the editor's own model (timelines.ts: the same refusals and words, each action a step of the timeline's
 * own Undo), rendered through the timeline's Render (its refusals, and the money rules of mcpRender.ts), finished,
 * exported, seen as a contact sheet, and stepped back and forth with its Undo and Redo.
 *
 * Each change an agent makes goes out as a "timelineEdit" live event (TimelineEdit) beside the "timeline" one the model
 * sends anyway: an editor open on that timeline says it in a toast with Undo (that step alone, the timeline's own Undo)
 * and rings the clips it touched.
 */

type View = Awaited<ReturnType<Timelines["view"]>>;
type ClipView = View["clips"][number];
type TakeView = NonNullable<ClipView["take"]>;

/**
 * What a "timelineEdit" live event says (events.ts relays it whole): the timeline, the token behind the change, what it did
 * in a few words, the clips it touched (still there), and the steps of the timeline's Undo it kept: the toast's Undo takes
 * them all back, and is refused once the timeline changed after them. `inputs`: the forms of the clips it changed, before
 * and after, so that an editor holding typing over one of them lays the agent's values over it (its next save keeps them).
 */
export interface TimelineEdit {
  id: string;
  by: string;
  token: string;
  at: string;
  said: string;
  clips: string[];
  /** The last of `steps` (null: none kept). */
  step: string | null;
  /** The steps it kept, in the order they were made. */
  steps?: string[];
  inputs?: Record<string, { was: Record<string, unknown>; now: Record<string, unknown> }>;
  /** Sent before the change is made: a token is changing the timeline now (an open editor leaves the user's zoom alone). */
  going?: true;
}

/** Said to the open editors before a change is made: the clips it adds are the token's, not the user's (useTrackZoom). */
function going(s: Services, ctx: ToolCtx, id: string): void {
  s.queue.events.emit("timelineEdit", { id, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), said: "", clips: [], step: null, going: true } satisfies TimelineEdit);
}

/** A timeline by its id, as the tools take it: refused with where to find the ids when there is none. */
async function viewOf(s: Services, id: string): Promise<View> {
  const row = await s.db.selectFrom("timelines").select("id").where("id", "=", id).executeTakeFirst();
  if (!row) throw httpError(`There is no timeline ${id}: list_timelines gives the ids, whats_open the one open.`, 404);
  return s.timelines.view(id);
}

/** A clip as the tools name it: its id, or its number on the timeline (1 = the first). */
const clipRef = z.union([z.string().min(1), z.number().int().min(1)]).describe("A clip: its id (read_timeline), or its number on the timeline (1 = the first).");
type ClipRef = z.infer<typeof clipRef>;

/** The clip a reference names on this timeline, and its place; refused with how many clips there are. */
function clipAt(view: View, ref: ClipRef): { clip: ClipView; i: number } {
  const i = typeof ref === "number" ? ref - 1 : view.clips.findIndex((c) => c.id === ref);
  const clip = view.clips[i];
  if (!clip) throw httpError(`${typeof ref === "number" ? `Clip ${ref}` : `The clip ${ref}`} is not on “${view.name}”: it has ${plural(view.clips.length, "clip")}.`, 404);
  return { clip, i };
}

/** A take as read_timeline says it: its number among the clip's takes, its video, what of it plays, whether it is a finish. */
function takeSaid(x: TakeView, takes: TakeView[]) {
  const draft = x.finishedFrom ? takes.findIndex((y) => y.id === x.finishedFrom) + 1 : 0;
  return {
    id: x.id, n: takes.findIndex((y) => y.id === x.id) + 1, item: x.asset.id,
    size: x.asset.width && x.asset.height ? `${x.asset.width}×${x.asset.height}` : null, fps: x.asset.fps,
    plays: { fromMs: Math.round(x.startMs), toMs: Math.round(x.endMs) }, videoMs: x.asset.durationMs,
    ...(x.trimStartMs || x.trimEndMs ? { trims: { startMs: x.trimStartMs, endMs: x.trimEndMs } } : {}),
    ...(x.finishedFrom ? { finishOf: draft ? `take ${draft}` : "a take removed since" } : {}),
    ...(x.joinKind ? { joinsBefore: x.joinKind } : {}),
    // a seamless take that cut to another shot where its run-up ends (card #161)
    ...(cutsAtJoin(x) ? { cutAtJoin: `${cutAtJoinFigure(x.measure!)}: ${cutAtJoinSaid(x.measure!)}` } : {}),
    ...(x.facePass ? { facePass: true } : {}),
  };
}

/** The recording a clip's form lays part by part, when it is one of a recording's clips. */
function recordingOf(s: Services, c: ClipView): string | null {
  const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
  const spec = recipe && recordingSpecOf(recipe.inputs as InputSpec[]);
  const v = spec ? c.inputs[spec.id] : undefined;
  return typeof v === "string" && v ? v : null;
}

/**
 * Why a clip cannot be rendered as it stands, as the editor's ready() says it (useClipEdits), or null: a still, a model gone,
 * a Lip sync clip waiting for its voice, a text to write, a picture to choose, a source video the lane gives.
 */
function whyNot(s: Services, view: View, i: number, input: Record<string, unknown>): { why: string; voice?: true } | null {
  const c = view.clips[i]!;
  if (c.kind === "still") return { why: "a still is not rendered" };
  const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
  if (!recipe) return { why: c.recipe ? "the model it was made with is no longer here: give it another form (edit_clip form)" : "it has no form yet: give it one (edit_clip form)" };
  const before = view.clips[i - 1];
  const carries = Boolean(before) && c.joined === "continue";
  const voice = (recipe.inputs as InputSpec[]).find((x) => x.type === "audio" && x.role === "sound" && x.window && !x.internal);
  if (voice && !input[voice.id]) return { why: `it waits for its voice: set ${voice.id} to a recording (edit_clip), or make clips from a recording (edit_timeline recording)`, voice: true };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type === "prompt" && ((!spec.optional && spec.default === undefined) || spec.example) && !String(input[spec.id] ?? "").trim()) return { why: `write its ${spec.label.toLowerCase()} first (${spec.id})` };
    const given = carries && spec.type === "image" && ((spec.role === "start" && (recipe.traits?.continues === "frame" || before?.kind === "still")) || Boolean(spec.opensOnly));
    if (spec.type === "image" && !spec.optional && !input[spec.id] && !given) return { why: `choose its ${spec.label.toLowerCase()} first (${spec.id})` };
    if (spec.type === "clip" && spec.role === "source" && !spec.optional && !input[spec.id]) return { why: `it has no ${spec.label.toLowerCase()}: give the timeline a source (edit_timeline source)` };
  }
  return null;
}

/** A clip's whole form as the editor's Render sends it (useClipEdits formOf): what it starts on here, with its own values over it. */
async function formSent(s: Services, at: Seen, recipe: Recipe<any>, own: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = await wholeOf(s, at, recipe, own);
  // the clips it joins onto are the timeline's to say, a source video the lane's
  for (const spec of recipe.inputs as InputSpec[]) if (input[spec.id] === undefined || (spec.type === "clip" && spec.role !== "source")) delete input[spec.id];
  return input;
}

/**
 * What switching a rendered clip's join would do to the take that plays, as the editor's join panel says it: a take always
 * plays from after its run-up, so a hard cut keeps it (no render), and back to seamless it carries on as it was made when it
 * still follows the clip before's take (joinIfSeamless), else it needs a new take.
 */
const switchedWords = (c: ClipView) =>
  c.joined === "continue"
    ? "hard cut: the take stays and plays from its own first frame, no render"
    : c.joinIfSeamless === "fresh"
      ? "seamless: the take carries on from the clip before's as it was made, no render"
      : "seamless: the take does not carry on from the clip before's take that plays, render a new one";

/** What is left to render, as Render all reads it: video clips with no take, a stale join or another Mirror, not in the queue. */
const toRender = (c: ClipView) => c.kind === "video" && !c.job && (!c.take || c.join === "stale" || c.mirrorChanged);

/** What a timeline needs a look at, as the editor's Needs attention lists it, each with what mends it. */
async function needsALook(s: Services, at: Seen, view: View) {
  const rows: Array<{ clips: number[]; what: string; mend: string }> = [];
  const n = (c: ClipView) => view.clips.indexOf(c) + 1;
  const waiting: Array<{ c: ClipView; why: string }> = [];
  const voiceless: ClipView[] = [];
  const ready: ClipView[] = [];
  for (const [i, c] of view.clips.entries()) {
    if (c.kind !== "video" || c.take || c.job || c.failed) continue;
    const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
    const why = whyNot(s, view, i, recipe ? await formSent(s, at, recipe, c.inputs) : c.inputs);
    if (why?.voice) voiceless.push(c);
    else if (why) waiting.push({ c, why: why.why });
    else ready.push(c);
  }
  if (ready.length) rows.push({ clips: ready.map(n), what: `${plural(ready.length, "clip")} with nothing rendered yet`, mend: "render_clips (all)" });
  for (const w of waiting) rows.push({ clips: [n(w.c)], what: `clip ${n(w.c)} cannot be rendered yet: ${w.why}`, mend: "edit_clip" });
  if (voiceless.length) rows.push({ clips: voiceless.map(n), what: `${plural(voiceless.length, "Lip sync clip")} waiting for a voice recording`, mend: "edit_clip (its recording), or edit_timeline recording" });
  // a clip that carries on from one with no take and none coming: its render is refused (card #128). A chain of them (a
  // source cut into windows, none rendered yet) is said once, from its first clip to its last, not once a join.
  const chains: number[][] = [];
  for (const [i, c] of view.clips.entries()) {
    const before = view.clips[i - 1];
    if (!before || c.kind !== "video" || c.joined !== "continue" || before.kind === "still" || before.take || before.job) continue;
    const last = chains.at(-1);
    if (last?.at(-1) === i) last.push(i + 1);
    else chains.push([i, i + 1]);
  }
  for (const chain of chains) {
    const [a, b] = [chain[0]!, chain.at(-1)!];
    rows.push(chain.length === 2
      ? { clips: chain, what: `clip ${b} carries on from clip ${a}, which has no take: its render is refused until clip ${a} has one`, mend: `render_clips with both (clip ${a} first: they are queued in order), or make their join a hard cut (edit_timeline join)` }
      : { clips: chain, what: `clips ${a + 1}–${b} each carry on from the clip before, which has no take: each one's render is refused until the clip before has one`, mend: `render_clips with clips ${a}–${b} (they are queued in order), or make a join a hard cut (edit_timeline join)` });
  }
  // a seamless join whose take cut to another shot where its run-up ends: a new take mends it (card #161)
  for (const c of view.clips) {
    if (c.joined === "continue" && c.join === "fresh" && cutsAtJoin(c.take)) rows.push({ clips: [n(c)], what: `clip ${n(c)}: ${cutAtJoinSaid(c.take!.measure!)}`, mend: "render_clips it again (a new take), then use_take the one that carries on" });
  }
  const stale = view.clips.filter((c) => c.join === "stale");
  if (stale.length) rows.push({ clips: stale.map(n), what: `${plural(stale.length, "join")} no longer follow on: the clip before changed after ${stale.length > 1 ? "they were" : "it was"} rendered`, mend: "render_clips them again" });
  const failed = view.clips.filter((c) => c.failed && !c.take);
  for (const c of failed) rows.push({ clips: [n(c)], what: `clip ${n(c)}'s render failed: ${c.failed}`, mend: "render_clips it again" });
  const mirrored = view.clips.filter((c) => c.take && c.mirrorChanged);
  if (mirrored.length) rows.push({ clips: mirrored.map(n), what: `${plural(mirrored.length, "clip")} rendered with other flips than Mirror asks now`, mend: "render_clips them again" });
  // the frame: a take of another shape than the timeline's is shown with bars
  if (view.width && view.height) {
    const ratio = view.width / view.height;
    const misfit = view.clips.filter((c) => c.take?.asset.width && c.take.asset.height && Math.abs(c.take.asset.width / c.take.asset.height - ratio) > 0.01 * ratio);
    if (misfit.length) rows.push({ clips: misfit.map(n), what: `${plural(misfit.length, "clip")} of another shape than the ${view.width}×${view.height} frame, shown with bars`, mend: "render them again at the frame's shape, or set the frame (edit_timeline settings)" });
  }
  // the model set check of what is left to render: a mix of files that gives black frames is refused at Render
  const checked = new Set<string>();
  for (const [i, c] of view.clips.entries()) {
    if (!toRender(c) || !c.recipe) continue;
    const recipe = s.registry.recipe(c.recipe);
    if (!recipe) continue;
    const input = await formSent(s, at, recipe, c.inputs);
    const key = JSON.stringify([recipe.id, input]);
    if (checked.has(key)) continue;
    checked.add(key);
    const found = await s.queue.setCheck(recipe.id, input).catch(() => []);
    for (const f of found) rows.push({ clips: [i + 1], what: `clip ${i + 1}: ${f.text}${f.black ? " (Render refuses this mix: it gives black frames)" : ""}`, mend: `edit_clip ${f.at}` });
  }
  return rows;
}

/** A timeline read whole, as read_timeline answers it. */
async function timelineSaid(s: Services, view: View) {
  const at = await seen(s);
  const planned = await s.timelines.plannedOf(view.id);
  const names = view.look?.cast.length ? await s.db.selectFrom("entities").select(["id", "name"]).where("id", "in", view.look.cast.map((c) => c.id)).execute() : [];
  const number = (id: string | null | undefined) => (id ? view.clips.findIndex((c) => c.id === id) + 1 || null : null);
  const clips = view.clips.map((c, i) => {
    const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
    const others = c.takes.filter((x) => x.id !== c.take?.id);
    return {
      n: i + 1, id: c.id, kind: c.kind,
      ...(c.kind === "still" ? { picture: c.still?.id ?? null } : { form: c.recipe, formTitle: recipe?.title ?? null }),
      atMs: c.atMs, lengthMs: c.lengthMs, ...(c.take || c.kind === "still" ? {} : { plannedMs: planned.get(c.id) ?? null }),
      join: i === 0 ? null : {
        with: `clip ${i}`, joined: c.joined === "continue" ? "seamless" : "hard cut",
        state: c.join === "fresh" ? "follows on" : c.join === "stale" ? "stale: the clip before changed since it was rendered" : c.join === "cut" ? "a hard cut" : "not rendered yet",
        // what the join panel's other card says, before the switch: a take always plays from after its run-up (timelineModel plays())
        ...(c.take && c.kind === "video" ? { ifSwitched: switchedWords(c) } : {}),
        ...(c.transition ? { transition: c.transition } : {}),
        ...(c.joined === "continue" && c.join === "fresh" && cutsAtJoin(c.take) ? { cutsHere: `${cutAtJoinFigure(c.take!.measure!)}: the take that plays cut to another shot after its run-up` } : {}),
      },
      // rendered to end where the next clip begins: a landing, when that one carries on from it
      ...(c.fitNext && view.clips[i + 1]?.joined === "continue" ? { landsOnNext: true } : {}),
      values: c.inputs,
      take: c.take ? takeSaid(c.take, c.takes) : null,
      otherTakes: others.map((x) => takeSaid(x, c.takes)),
      ...(c.kind === "video" && c.sound !== "own" ? { sound: { heard: c.sound, ...(c.soundAsset ? { item: c.soundAsset.id } : {}) } } : {}),
      ...(c.volume !== 100 ? { volume: c.volume } : {}),
      ...(recordingOf(s, c) ? { recording: recordingOf(s, c) } : {}),
      ...(c.look ? { ownCast: true } : {}),
      ...(c.music ? { music: c.music } : {}),
      ...(c.pinMirror.length ? { mirrored: c.pinMirror } : {}),
      ...(c.job ? { rendering: { job: c.job.id, status: c.job.status === "running" ? "running" : "waiting" } } : {}),
      ...(c.failed ? { failed: c.failed } : {}),
    };
  });
  const rendered = view.clips.filter((c) => c.take || (c.kind === "still" && c.still));
  return {
    id: view.id, name: view.name, frame: view.width && view.height ? { width: view.width, height: view.height } : "the first clip rendered sets it",
    project: view.projectId, folder: view.folderId, mood: view.mood || null,
    cast: view.look ? { people: view.look.cast.map((c) => names.find((p) => p.id === c.id)?.name ?? c.id), style: view.look.style ?? null } : null,
    length: { plannedMs: view.clips.reduce((sum, c) => sum + (planned.get(c.id) ?? 0), 0), renderedMs: view.durationMs, clips: view.clips.length, rendered: rendered.length },
    clips,
    lanes: {
      video: `${plural(view.clips.length, "clip")} on the track`,
      audio: view.recordings.map((r) => ({
        recording: r.asset.id, name: r.asset.name, durationMs: r.asset.durationMs,
        clips: view.clips.flatMap((c, i) => (recordingOf(s, c) === r.asset.id ? [i + 1] : [])),
        ...("seconds" in r ? { cut: { seconds: r.seconds, window: r.window } } : {}),
        ...(r.parked ? { setAside: `${plural(r.parked, "clip")} past its Out (trim_recording brings them back)` } : {}),
        removed: r.removed.map((p) => ({ beforeClip: number(p.before), fromMs: p.fromMs, toMs: p.toMs, clips: p.clips, takes: p.takes })),
      })),
      source: view.source ? {
        video: view.source.video.id, name: view.source.video.name, durationMs: view.source.video.durationMs,
        atMs: view.source.atMs, fromMs: view.source.fromMs, toMs: view.source.toMs, form: view.source.recipe, windowMs: view.source.windowMs, within: view.source.withinMs / 1000, values: view.source.inputs,
        removed: view.source.removed.map((p) => ({ beforeClip: number(p.before), fromMs: p.fromMs, toMs: p.toMs, clips: p.clips, takes: p.takes })),
      } : null,
      music: view.music ? {
        item: view.music.asset.id, name: view.music.asset.name, volume: view.music.volume, fadeInMs: view.music.fadeInMs, fadeOutMs: view.music.fadeOutMs,
        duck: view.music.duck ? `${view.music.duckDb} dB under speech` : false, fromMs: view.music.fromMs, startsWith: view.music.startClip ? `clip ${number(view.music.startClip)}` : "clip 1",
      } : null,
    },
    needsALook: await needsALook(s, at, view),
    undo: view.undo, redo: view.redo,
    export: view.exporting ? { job: view.exporting.id, status: view.exporting.status === "running" ? "running" : "waiting" } : view.exported ? { item: view.exported.id, durationMs: view.exported.durationMs } : view.exportFailed ? { failed: view.exportFailed } : null,
  };
}

const listTimelines = tool({
  name: "list_timelines",
  scope: "look",
  title: "Timelines",
  description: "The timelines, the most recently changed first: id, name, how many clips and how long it plays, the clips left to render and the joins that no longer follow on, its project. `project`: one project's (\"none\" for the Inbox).",
  input: { project: z.string().optional() },
  async run({ project }, ctx) {
    const { items } = await ctx.s.timelines.list(project);
    ctx.said(`Listed the timelines: ${plural(items.length, "timeline")}`);
    return items.map((t) => ({ id: t.id, name: t.name, clips: t.clips, durationMs: t.durationMs, toRender: t.toRender, staleJoins: t.staleJoins, frame: t.width && t.height ? `${t.width}×${t.height}` : null, project: t.projectId, updatedAt: t.updatedAt }));
  },
});

const readTimeline = tool({
  name: "read_timeline",
  scope: "look",
  title: "Read a timeline",
  description: "One timeline whole: its clips in order (each one's form and values, where it starts and how long it plays or is planned to, the take that plays and the other takes, its join with the clip before: hard cut or seamless, follows on or stale, what switching it does to its take, its transition), its lanes (the recordings under Lip sync clips with the parts removed from them, the source video cut into windows, the music), what needs a look (clips to render, forms to fill, a continuation with nothing to carry on from, stale joins, failures, model set problems, clips of another shape), its planned and rendered length, what Undo and Redo would do, and its export. A clip's values are its form's, for its next render (seed -1: a new one each time); the seed a take was made with is that take's own (view_item › made with).",
  input: { timeline: z.string().min(1).describe("A timeline's id (list_timelines, whats_open).") },
  async run({ timeline }, ctx) {
    const view = await viewOf(ctx.s, timeline);
    ctx.said(`Read the timeline “${view.name}”: ${plural(view.clips.length, "clip")}`);
    return timelineSaid(ctx.s, view);
  },
});

const newTimeline = tool({
  name: "new_timeline",
  scope: "make",
  title: "New timeline",
  description: "A new, empty timeline, in a project (or the Inbox) and optionally a folder its renders land in. Add clips with edit_timeline.",
  input: {
    name: z.string().max(200).optional(),
    project: z.string().optional().describe("A project's id (list_places); left out: the Inbox."),
    folder: z.string().optional().describe("A folder of that project its renders land in; left out: the project's root."),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const project = args.project ?? null;
    if (project && !(await s.db.selectFrom("projects").select("id").where("id", "=", project).executeTakeFirst())) throw httpError("There is no such project: list_places gives the ids.", 404);
    let made: View;
    if (args.folder) {
      // as the web makes one inside a folder: it lives and renders there, chosen
      const f = await s.db.selectFrom("folders").select(["id", "project_id"]).where("id", "=", args.folder).executeTakeFirst();
      if (!f) throw httpError("There is no such folder: list_places gives the ids.", 404);
      if ((f.project_id ?? null) !== project) throw httpError("That folder is not in this project.");
      made = await s.timelines.create(args.name, project, f.id, true);
    } else made = await s.timelines.create(args.name, project, await rootFolderOf(s.db, project));
    ctx.said(`Made the timeline “${made.name}”`);
    return { id: made.id, name: made.name, project: made.projectId };
  },
});

// ------------------------------------------------------------------------------------------------- edit_timeline

const transition = z.strictObject({
  kind: z.enum(TRANSITION_KINDS),
  ms: z.number().min(TRANSITION_MS.least).max(TRANSITION_MS.most),
  sound: z.enum(["on", "fade"]).default("fade"),
});

/** One action of edit_timeline, as the editor does it. */
const action = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("add"), form: z.string().optional().describe("A form's id (list_forms) for a clip to render."), item: z.string().optional().describe("Or a library item: a video plays as it is; a picture is held on screen (as: still) or opens a clip to render (as: clip)."), as: z.enum(["still", "clip"]).optional(), after: clipRef.nullable().optional().describe("The clip it goes after; null: first; left out: last."), stopAtMs: z.number().min(0).optional().describe("The clip it goes after stops being seen at this moment of its take first.") }),
  z.strictObject({ do: z.literal("move"), clip: clipRef, after: clipRef.nullable().describe("The clip it goes after; null: first.") }),
  z.strictObject({ do: z.literal("trim"), clip: clipRef, fromMs: z.number().min(0).optional().describe("Where it starts being seen, in its take's own time (read_timeline's take › plays)."), toMs: z.number().min(0).optional().describe("Where it stops being seen, likewise.") }),
  z.strictObject({ do: z.literal("split"), clip: clipRef, atMs: z.number().min(0).describe("In its take's own time, inside what plays.") }),
  z.strictObject({ do: z.literal("remove"), clips: z.array(clipRef).min(1).max(200) }),
  z.strictObject({ do: z.literal("bring_back"), before: clipRef.describe("The clip a removed part of a recording or of the source is kept with (read_timeline › lanes › removed › beforeClip).") }),
  z.strictObject({ do: z.literal("duplicate"), clip: clipRef }),
  z.strictObject({ do: z.literal("join"), clip: clipRef.describe("The later clip of the join."), join: z.enum(["hard cut", "seamless", "landing", "cut"]).optional().describe("hard cut (cut: the same): it starts on its own, its take kept and played from its own first frame (no render); seamless: it carries on from the clip before (no render when its take was made from that clip's take); landing: seamless, and the clip before is rendered to end where this one begins (this one rendered first)."), transition: transition.nullable().optional().describe("A hard cut's transition into it (makes the join a hard cut); null: none, a plain hard cut.") }),
  z.strictObject({ do: z.literal("still"), clip: clipRef, ms: z.number().min(500).max(60_000).describe("How long a still is held.") }),
  z.strictObject({ do: z.literal("sound"), clip: clipRef, heard: z.enum(["own", "muted", "file"]).optional(), item: z.string().nullable().optional().describe("With heard: file, the sound (a library item) heard instead."), volume: z.number().min(0).max(100).optional() }),
  z.strictObject({ do: z.literal("music"), item: z.string().nullable().optional().describe("A sound (or a video with sound) of the library; null takes the music away."), volume: z.number().min(0).max(100).optional(), fadeInMs: z.number().min(0).optional(), fadeOutMs: z.number().min(0).optional(), duck: z.boolean().optional(), duckDb: z.number().min(3).max(30).optional(), fromMs: z.number().min(0).optional().describe("Where in the song it plays from."), startClip: clipRef.nullable().optional().describe("The clip it starts with; null: the first.") }),
  z.strictObject({ do: z.literal("recording"), item: z.string().describe("A voice recording (a sound, or a video with sound) made into Lip sync clips cut at its pauses."), clip: clipRef.optional().describe("An empty clip it goes in place of; left out: after the last clip."), seconds: z.number().min(1).max(60).optional().describe("Clip length (5 by default)."), window: z.number().min(0).max(CUT_WINDOW_MOST).optional().describe("± this many seconds around the clip length, where a pause, a line's end or the quietest moment is looked for.") }),
  z.strictObject({ do: z.literal("recut_recording"), item: z.string(), seconds: z.number().min(1).max(60), window: z.number().min(0).max(CUT_WINDOW_MOST) }),
  z.strictObject({ do: z.literal("trim_recording"), item: z.string(), fromMs: z.number().min(0), toMs: z.number().min(0) }),
  z.strictObject({ do: z.literal("source"), item: z.string().nullable().optional().describe("A long video of the library on the Source lane; null takes the source away."), atMs: z.number().optional().describe("Where its start sits on the timeline."), fromMs: z.number().min(0).optional(), toMs: z.number().min(0).optional().describe("The stretch of it made into clips."), form: z.string().optional().describe("The windowed form its windows are made with (Motion transfer, Swap character…)."), windowMs: z.number().min(500).max(60_000).optional().describe("Clip length: how long each window is asked to be."), within: z.number().min(0).max(CUT_WINDOW_MOST).optional().describe("± seconds of windowMs a window may end at a better spot: a scene cut (the next window opens the new shot), else a pause in the speech, else the quietest moment. 0: every window windowMs long."), values: z.record(z.string(), z.unknown()).optional().describe("The form's inputs every window is made with (run-up, prompt, references…), checked as the form checks them.") }),
  z.strictObject({ do: z.literal("make_source"), again: z.boolean().optional().describe("Cut again into the clips it made (the rendered ones kept).") }),
  z.strictObject({ do: z.literal("split_source"), atMs: z.number().min(0) }),
  z.strictObject({ do: z.literal("trim_source"), fromMs: z.number().min(0), toMs: z.number().min(0) }),
  z.strictObject({ do: z.literal("settings"), name: z.string().max(200).optional(), mood: z.string().max(2000).optional(), frame: z.strictObject({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }).nullable().optional().describe("The frame every clip is made to fit; null: the first clip rendered decides."), cast: z.array(z.string()).optional().describe("The timeline's cast, whole: Prompt kit people by name or id.") }),
]);
type Action = z.infer<typeof action>;

/** A library item that is there and not in the bin, of these kinds; refused in the words of the slot it goes in. */
async function itemOf(s: Services, id: string, kinds: string[], what: string) {
  const a = await s.db.selectFrom("assets").select(["id", "kind", "has_sound", "deleted_at", "name"]).where("id", "=", id).executeTakeFirst();
  if (!a || a.deleted_at) throw httpError(`There is no library item ${id}${a ? " outside the bin" : ""}: search_library gives the ids.`, 404);
  if (!kinds.includes(a.kind)) throw httpError(`${what}: ${id} is ${a.kind === "image" ? "a picture" : a.kind === "audio" ? "a sound" : "a video"}.`);
  return a;
}

/** What one action did, said to the agent; a removal says what went and that undo brings it back. */
async function runAction(s: Services, ctx: ToolCtx, id: string, a: Action): Promise<string> {
  const t = s.timelines;
  const view = await t.view(id);
  const clip = (ref: ClipRef) => clipAt(view, ref);
  const after = (ref: ClipRef | null | undefined) => (ref === undefined ? undefined : ref === null ? null : clip(ref).clip.id);
  const edit = (c: ClipView, patch: ClipPatch) => t.editClip(c.id, patch);
  switch (a.do) {
    case "add": {
      if (!a.form && !a.item) throw httpError("Say what to add: a form, or a library item.");
      if (a.form) formOf(s, a.form);
      if (a.item) await itemOf(s, a.item, ["image", "video"], "A clip is a picture or a video");
      const made = await t.addClip(id, { after: after(a.after), recipe: a.form, asset: a.item, as: a.as, stopAtMs: a.stopAtMs });
      const n = (await t.view(id)).clips.findIndex((c) => c.id === made) + 1;
      return `added clip ${n} (${made})`;
    }
    case "move": {
      const { i } = clip(a.clip);
      await edit(view.clips[i]!, { after: after(a.after) });
      const n = (await t.view(id)).clips.findIndex((c) => c.id === view.clips[i]!.id) + 1;
      return `moved clip ${i + 1}: it is clip ${n} now`;
    }
    case "trim": {
      const { clip: c, i } = clip(a.clip);
      if (a.fromMs === undefined && a.toMs === undefined) throw httpError("Say where it starts or stops being seen (fromMs, toMs).");
      await edit(c, { shownFromMs: a.fromMs, shownToMs: a.toMs });
      const now = clipAt(await t.view(id), c.id).clip;
      return `trimmed clip ${i + 1}: it plays ${Math.round(now.take?.startMs ?? 0)}–${Math.round(now.take?.endMs ?? 0)} ms of its take (${now.lengthMs} ms)`;
    }
    case "split": {
      const { clip: c, i } = clip(a.clip);
      await t.range.splitClip(c.id, a.atMs);
      return `split clip ${i + 1} at ${a.atMs} ms of its take: clips ${i + 1} and ${i + 2}`;
    }
    case "remove": {
      const picked = [...new Map(a.clips.map((r) => clip(r)).map((x) => [x.clip.id, x])).values()].sort((x, y) => x.i - y.i);
      await t.removeClips(id, picked.map((x) => x.clip.id));
      const takes = picked.reduce((sum, x) => sum + x.clip.takes.length, 0);
      const parts = picked.filter((x) => recordingOf(s, x.clip)).length;
      // as the editor's ripple cut: nothing asked, the clips after close the gap
      const closes = view.clips.length - 1 > picked.at(-1)!.i;
      return `removed ${picked.length > 1 ? `clips ${picked.map((x) => x.i + 1).join(", ")}` : `clip ${picked[0]!.i + 1}`}${takes ? ` with ${plural(takes, "take")}` : ""}${closes ? ": the clips after closed the gap" : ""}${parts ? `; ${parts > 1 ? "their parts were" : "its part was"} cut out of the recording (bring_back puts a part from the middle back)` : ""}. undo brings ${picked.length > 1 ? "them" : "it"} back`;
    }
    case "bring_back": {
      const { clip: c, i } = clip(a.before);
      await t.bringBack(id, c.id);
      return `brought back the part removed before clip ${i + 1}`;
    }
    case "duplicate": {
      const { clip: c, i } = clip(a.clip);
      await t.range.duplicateClip(c.id);
      s.queue.events.emit("timeline");
      return `duplicated clip ${i + 1}: the copy is clip ${i + 2}`;
    }
    case "join": {
      const { clip: c, i } = clip(a.clip);
      if (!i) throw httpError("Clip 1 has no clip before it: a join is said on the later clip.");
      if (a.join === undefined && a.transition === undefined) throw httpError("Say the join (hard cut, seamless, landing) or a transition.");
      const hardCut = a.join === "hard cut" || a.join === "cut";
      if (a.transition && a.join && !hardCut) throw httpError("A transition goes on a hard cut: say join hard cut, or leave join out.");
      const before = view.clips[i - 1]!;
      if (a.join === "landing") {
        if (!c.take) throw httpError(`Clip ${i + 1} has no take yet: a landing ends clip ${i} where clip ${i + 1} begins, so clip ${i + 1} is rendered first.`);
        if (before.kind !== "video") throw httpError(`Clip ${i} is a still: it lands on nothing.`);
      }
      await edit(c, { ...(a.join ? { joined: hardCut ? "cut" : "continue" } : {}), ...(a.transition !== undefined ? { transition: a.transition } : {}) });
      if (a.join === "landing" && !before.fitNext) await edit(before, { fitNext: true });
      if (a.join === "landing") return `clip ${i + 1} carries on from clip ${i}, and clip ${i} is to land on it: render clip ${i} (again) to make it end where clip ${i + 1} begins`;
      if (a.transition) return `a ${a.transition.kind} of ${a.transition.ms} ms into clip ${i + 1}`;
      if (a.transition === null) return `a plain hard cut into clip ${i + 1}`;
      if (hardCut) return `the join into clip ${i + 1} is a hard cut${c.take ? ": its take stays and plays from its own first frame, no render" : ""}`;
      // back to seamless: no render while its take still carries on from the clip before's (as the join panel says it)
      const follows = c.joined === "continue" ? c.join === "fresh" : c.joinIfSeamless === "fresh";
      return `the join into clip ${i + 1} is seamless${c.take ? (follows ? ": its take carries on as it was made, no render" : ": render it again to make the join follow on") : ""}`;
    }
    case "still": {
      const { clip: c, i } = clip(a.clip);
      await edit(c, { stillMs: a.ms });
      return `clip ${i + 1} is held ${a.ms} ms`;
    }
    case "sound": {
      const { clip: c, i } = clip(a.clip);
      if (a.item) await itemOf(s, a.item, ["audio", "video"], "The sound heard is a sound, or a video with sound");
      await edit(c, { ...(a.heard ? { sound: a.heard } : {}), ...(a.item !== undefined ? { soundAsset: a.item } : {}), ...(a.volume !== undefined ? { volume: a.volume } : {}) });
      return `clip ${i + 1}'s sound changed`;
    }
    case "music": {
      if (a.item) await itemOf(s, a.item, ["audio", "video"], "The music is a sound, or a video with sound");
      const music: NonNullable<TimelinePatch["music"]> = { asset: a.item, volume: a.volume, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs, duck: a.duck, duckDb: a.duckDb, fromMs: a.fromMs, startClip: after(a.startClip) };
      await t.edit(id, { music: Object.fromEntries(Object.entries(music).filter(([, v]) => v !== undefined)) });
      return a.item === null ? "took the music away" : "the music lane changed";
    }
    case "recording": {
      await itemOf(s, a.item, ["audio", "video"], "A recording is a sound, or a video with sound");
      const into = a.clip === undefined ? undefined : clip(a.clip);
      if (into && (into.clip.take || into.clip.kind !== "video")) throw httpError(`Clip ${into.i + 1} is not an empty clip: a recording goes in place of an empty clip, or after the last one.`);
      const made = await t.makeFromRecording(id, { asset: a.item, clip: into?.clip.id, seconds: a.seconds, window: a.window, keepCut: a.seconds !== undefined || a.window !== undefined });
      const now = await t.view(id);
      const at = made.map((m) => now.clips.findIndex((c) => c.id === m) + 1);
      return `made ${plural(made.length, "Lip sync clip")} from the recording (clips ${at[0]}–${at.at(-1)}), cut at its pauses${a.seconds ? ` about every ${a.seconds} s` : ""}${a.window !== undefined ? ` ± ${a.window} s` : ""}: nothing rendered yet`;
    }
    case "recut_recording": {
      const { clips } = await t.cutRecording(id, { asset: a.item, seconds: a.seconds, window: a.window });
      return `cut the recording again into ${plural(clips.length, "clip")} of about ${a.seconds} s ± ${a.window} s`;
    }
    case "trim_recording": {
      const { clips } = await t.trimRecording(id, { asset: a.item, fromMs: a.fromMs, toMs: a.toMs });
      return `trimmed the recording to ${a.fromMs}–${a.toMs} ms: ${plural(clips.length, "clip")} under it`;
    }
    case "source": {
      if (a.item === null) {
        await t.edit(id, { source: null });
        return "took the source away";
      }
      if (a.item) await itemOf(s, a.item, ["video"], "A source is a video");
      const form = a.form ?? view.source?.recipe ?? undefined;
      let inputs: Record<string, unknown> | undefined;
      if (a.values) {
        if (!form) throw httpError("Give the source a form first (form), then its values.");
        const recipe = formOf(s, form);
        const at = await seen(s);
        // null takes an input out, as edit_clip's does
        const checked = await checkedValues(s, at, recipe, a.values);
        inputs = Object.fromEntries(Object.entries({ ...(view.source?.inputs ?? {}), ...checked }).filter(([, v]) => v !== null));
      }
      if (a.form) formOf(s, a.form);
      const patch = { asset: a.item, atMs: a.atMs, fromMs: a.fromMs, toMs: a.toMs, recipe: a.form, windowMs: a.windowMs, withinMs: a.within === undefined ? undefined : Math.round(a.within * 1000), inputs };
      await t.edit(id, { source: Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
      return `the source lane changed${view.clips.length && view.source ? "" : ": make_source cuts it into clips"}`;
    }
    case "make_source": {
      const made = await t.makeFromSource(id, { again: a.again });
      return `made ${plural(made.length, "clip")} from the source, window by window: nothing rendered yet`;
    }
    case "split_source": {
      await t.splitSource(id, a.atMs);
      return `split the source at ${a.atMs} ms: the part before is a clip playing it as it is`;
    }
    case "trim_source": {
      const r = await t.trimSource(id, { fromMs: a.fromMs, toMs: a.toMs });
      return `trimmed the source's stretch to ${a.fromMs}–${r.toMs} ms${r.said ? `: ${r.said}` : ""}`;
    }
    case "settings": {
      const patch: TimelinePatch = {
        ...(a.name !== undefined ? { name: a.name } : {}), ...(a.mood !== undefined ? { mood: a.mood } : {}),
        ...(a.frame !== undefined ? { width: a.frame?.width ?? null, height: a.frame?.height ?? null } : {}),
        ...(a.cast ? { look: { cast: await castOf(s, a.cast), style: view.look?.style ?? null, snippets: view.look?.snippets ?? [] } } : {}),
      };
      if (!Object.keys(patch).length) throw httpError("Say what to change: name, mood, frame or cast.");
      await t.edit(id, patch);
      return `the timeline's ${Object.keys(patch).filter((k) => k !== "height").map((k) => (k === "width" ? "frame" : k === "look" ? "cast" : k)).join(", ")} changed`;
    }
  }
}

/** What changed between two views of a timeline: the clips added or changed (in form, join, take, trims or place), still there. */
function touched(before: View, after: View): string[] {
  const was = new Map(before.clips.map((c, i) => [c.id, { c, i }]));
  const key = (c: ClipView) => JSON.stringify([c.recipe, c.inputs, c.joined, c.transition, c.take?.id, c.take?.trimStartMs, c.take?.trimEndMs, c.fitNext, c.sound, c.soundAsset?.id, c.volume, c.lengthMs, c.kind]);
  return after.clips.filter((c, i) => {
    const w = was.get(c.id);
    return !w || key(w.c) !== key(c) || (w.i !== i && before.clips[w.i - 1]?.id !== after.clips[i - 1]?.id);
  }).map((c) => c.id);
}

/**
 * An agent's change, said to the editors open on the timeline: the toast with its Undo (the steps it kept), the clips it
 * touched ringed, the forms it changed. Nothing when nothing changed.
 */
async function saidLive(s: Services, ctx: ToolCtx, before: View, said: string, steps: string[]): Promise<void> {
  const after = await s.timelines.view(before.id);
  const clips = touched(before, after);
  if (!clips.length && JSON.stringify({ ...before, clips: null, updatedAt: null }) === JSON.stringify({ ...after, clips: null, updatedAt: null })) return;
  const was = new Map(before.clips.map((c) => [c.id, c]));
  const inputs = Object.fromEntries(after.clips.flatMap((c) => {
    const w = was.get(c.id);
    return w && JSON.stringify(w.inputs) !== JSON.stringify(c.inputs) ? [[c.id, { was: w.inputs, now: c.inputs }]] : [];
  }));
  s.queue.events.emit("timelineEdit", {
    id: before.id, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), said, clips, step: steps.at(-1) ?? null, steps,
    ...(Object.keys(inputs).length ? { inputs } : {}),
  } satisfies TimelineEdit);
}

/**
 * An agent's change to a timeline, made in the timeline's turn from its reading to the reading of what it did (the turn is
 * re-entrant: the change's own turns run inside it). What it works from is the timeline as it is then, not as read before
 * the turn (a clip's form written whole put back what the user saved meanwhile); the clips it rings and the steps its Undo
 * takes back are its own, never a change the user made in between. `said`: what it did in a few words, once done or
 * refused (null: nothing to say; a refused list still says the actions done before it).
 */
async function agentChange<T>(s: Services, ctx: ToolCtx, id: string, work: (before: View) => Promise<T>, said: (out: T | undefined) => string | null): Promise<T> {
  going(s, ctx, id);
  return s.timelines.history.oneAtATime(id, async () => {
    const before = await viewOf(s, id);
    const top = await s.timelines.history.last(id);
    let out: T | undefined;
    try {
      out = await work(before);
      return out;
    } finally {
      const words = said(out);
      if (words !== null) await saidLive(s, ctx, before, words, await s.timelines.history.keptSince(id, top?.seq ?? null));
    }
  });
}

const editTimeline = tool({
  name: "edit_timeline",
  scope: "make",
  title: "Edit a timeline",
  description: [
    "Change a timeline as its editor does, one action or a short list run in order (each one a step of the timeline's own Undo; a refused action stops the list there, the ones before it done). Clips are named by id or by number (1 = first), as the timeline stands when the action runs.",
    "Actions (`do`): add (a form's clip to render, or a library video or picture); move; trim (what is seen, in the take's own time); split (refused on a recording's clip or a window of the source: remove it, or cut again); remove (the editor's ripple cut, asked nothing: the result says what went, undo brings it back; a recording's or the source's clip has its part cut out, bring_back puts a part from the middle back); bring_back; duplicate;",
    "join (hard cut, seamless, landing; or a transition on a hard cut, centred on it: it plays over the end of the clip before and the start of this one, and the timeline keeps its length); still (how long a picture is held); sound (a clip's own, muted, or a file); music (the music lane: song, volume, fades, ducking, where it plays from and the clip it starts with);",
    "recording (a voice recording made into Lip sync clips cut at its pauses, Clip length ± window); recut_recording; trim_recording; source (a long video on the Source lane: its stretch, windowed form, window length, scene cuts, the form's values such as the run-up); make_source; split_source; trim_source; settings (name, mood, frame, cast).",
    "Nothing renders here: render_clips does. An editor open on the timeline shows the change at once, with a toast whose Undo takes it back.",
  ].join(" "),
  input: { timeline: z.string().min(1), actions: z.array(action).min(1).max(20).describe("Run in order.") },
  async run({ timeline, actions }, ctx) {
    const { s } = ctx;
    const before = await viewOf(s, timeline);
    const done: string[] = [];
    // the whole list in one turn: the toast's Undo takes all of it back, and no step of the user's lands between its actions
    await agentChange(s, ctx, timeline, async () => {
      for (const [k, a] of actions.entries()) {
        try {
          done.push(await runAction(s, ctx, timeline, a));
        } catch (err) {
          const e = err as Error & { statusCode?: number };
          // the actions before stay done (each its own step): said with the refusal, so that the agent knows where it stands
          const why = `${actions.length > 1 ? `Action ${k + 1} (${a.do}) was refused` : "Refused"}: ${e.message}${done.length ? ` The ${plural(done.length, "action")} before it ${done.length > 1 ? "were" : "was"} done (${done.join("; ")}); undo takes ${done.length > 1 ? "them back one at a time" : "it back"}.` : ""}`;
          throw e.statusCode ? httpError(why, e.statusCode) : e;
        }
      }
    }, () => (!done.length ? null : done.length > 1 ? plural(done.length, "change") : done[0]!));
    ctx.said(`Changed “${before.name}”: ${done.join("; ")}`);
    return { done, undo: (await s.timelines.history.last(timeline))?.label ?? null };
  },
});

const editClip = tool({
  name: "edit_clip",
  scope: "make",
  title: "Edit a clip",
  description: "A clip's own form, as its panel in the editor changes it: any input by id (`set`, null to take it out so it follows the form's start again), checked as the form checks it (describe_form says each value), another form, its own cast (Prompt kit people), whether it is rendered to end where the next clip begins (landsOnNext). A clip of the source changes every window's form unless `share` says otherwise. One step of the timeline's Undo; an editor open on it shows the change at once, the clip ringed, with Undo.",
  input: {
    timeline: z.string().min(1),
    clip: clipRef,
    form: z.string().optional().describe("Another form for it (list_forms): a clip under a recording takes only a form made around one."),
    set: z.record(z.string(), z.unknown()).optional().describe("Inputs by id → value; null takes it out."),
    cast: z.array(z.string()).nullable().optional().describe("Its own cast: Prompt kit people by name or id; null: the timeline's again."),
    landsOnNext: z.boolean().optional(),
    share: z.enum(["apart", "inLine", "toAll"]).optional().describe("Of a clip of the source: apart, this clip's own; inLine, its settings back to the others'; toAll, its settings to every clip."),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, args.timeline);
    const asked = clipAt(view, args.clip).clip.id;
    const at = await seen(s);
    // worked out in the timeline's turn from the clip as it is then: its form written whole from a reading made before put
    // back what the user saved meanwhile
    const { c, i, kept } = await agentChange(s, ctx, view.id, async (then) => {
      const { clip: c, i } = clipAt(then, asked);
      if (c.kind === "still" && (args.form || args.set)) throw httpError(`Clip ${i + 1} is a still: it has no form. Make it a clip to render by adding the picture again as a clip (edit_timeline add, as: clip).`);
      const recipe = formOf(s, args.form ?? c.recipe ?? "");
      const inputs: Record<string, unknown> = { ...c.inputs };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(await checkedValues(s, at, recipe, args.set ?? {}))) {
        if (v === null) delete inputs[k];
        else inputs[k] = v;
        changed.push(k);
      }
      const patch: ClipPatch = {
        ...(args.form && args.form !== c.recipe ? { recipe: recipe.id } : {}),
        ...(args.set ? { inputs } : {}),
        ...(args.cast !== undefined ? { look: args.cast === null ? null : { cast: await castOf(s, args.cast), style: c.look?.style ?? then.look?.style ?? null, snippets: c.look?.snippets ?? then.look?.snippets ?? [] } } : {}),
        ...(args.landsOnNext !== undefined ? { fitNext: args.landsOnNext } : {}),
        ...(args.share ? { share: args.share } : {}),
      };
      if (!Object.keys(patch).length) throw httpError("Say what to change: form, set, cast, landsOnNext or share.");
      // a step of its own, named for the agent: never folded into what the user is typing in the same clip
      const kept = await s.timelines.editClip(c.id, patch, { step: `${ctx.token.name}'s change to clip ${i + 1}` });
      const said = `clip ${i + 1}: ${[...(patch.recipe ? ["form"] : []), ...changed, ...(patch.look !== undefined ? ["cast"] : []), ...(patch.fitNext !== undefined ? ["lands on next"] : [])].join(", ")}`;
      return { c, i, kept, said };
    }, (out) => out?.said ?? null);
    ctx.said(`Changed clip ${i + 1} of “${view.name}”`);
    const now = clipAt(await s.timelines.view(view.id), c.id).clip;
    const why = whyNot(s, await s.timelines.view(view.id), i, now.recipe ? await formSent(s, at, formOf(s, now.recipe), now.inputs) : now.inputs);
    return { clip: i + 1, form: now.recipe, values: kept.inputs ?? now.inputs, ready: why ? why.why : "ready to render", ...(c.take ? { note: "its take was made with the form as it was: render_clips makes a new one" } : {}) };
  },
});

// ------------------------------------------------------------------------------------------------- rendering

const renderClipsTool = tool({
  name: "render_clips",
  scope: "make",
  title: "Render clips",
  description: "Render clips of a timeline through its Render: all that are left (no take, a stale join, another Mirror: Render all), a range of clip numbers, or the clips picked, in the order they play; a clip that carries on from one rendered with it waits for that one's take. The editor's refusals hold (a clip whose form is not filled; a continuation with nothing to carry on from, card #128; files known to give black frames), and the token's limits: renders an hour, rented pods only with Spend and within its cap. Answers the job ids (job follows them).",
  input: {
    timeline: z.string().min(1),
    clips: z.array(clipRef).min(1).max(100).optional().describe("The clips to render; left out with no range: all that are left to render."),
    from: z.number().int().min(1).optional().describe("Or a range of clip numbers, from…"),
    to: z.number().int().min(1).optional().describe("…to (both included)."),
    takes: z.number().int().min(1).max(4).optional().describe("Takes of each clip (1–4)."),
    machine: z.string().optional().describe("A machine's id or name (overview); left out, the queue picks among those this token may use."),
  },
  async run(args, ctx) {
    const { s, token } = ctx;
    const view = await viewOf(s, args.timeline);
    const at = await seen(s);
    const machine = args.machine ? machineOf(at, args.machine) : undefined;
    const ranged = args.from !== undefined || args.to !== undefined;
    if (args.clips && ranged) throw httpError("Pick clips, or a range: not both.");
    const picked = args.clips
      ? [...new Set(args.clips.map((r) => clipAt(view, r).i))].sort((a, b) => a - b)
      : ranged
        ? view.clips.flatMap((_, i) => (i + 1 >= (args.from ?? 1) && i + 1 <= (args.to ?? view.clips.length) ? [i] : []))
        : view.clips.flatMap((c, i) => (toRender(c) ? [i] : []));
    if (!picked.length) throw httpError(ranged ? "No clip is in that range." : `Nothing is left to render on “${view.name}”: every clip has a take that follows on. Pick clips to render them again.`);
    const takes = args.takes ?? 1;
    const asked: Array<{ id: string; input: Record<string, unknown>; takes: number; recipe: string }> = [];
    const skipped: string[] = [];
    for (const i of picked) {
      const c = view.clips[i]!;
      const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
      const input = recipe ? await formSent(s, at, recipe, c.inputs) : c.inputs;
      const why = whyNot(s, view, i, input);
      // Render all leaves out what cannot render, as the editor's does; a clip picked by name is refused, as its Render is greyed
      if (why || c.job) {
        if (!args.clips && !ranged) {
          skipped.push(`clip ${i + 1}: ${why?.why ?? "already rendering"}`);
          continue;
        }
        throw httpError(`Clip ${i + 1} cannot be rendered: ${why?.why ?? "it is already rendering or in the queue (job cancels it)"}.`);
      }
      asked.push({ id: c.id, input, takes, recipe: recipe!.id });
    }
    if (!asked.length) throw httpError(`None of these clips can be rendered: ${skipped.join("; ")}.`);
    // the checks and the queueing in one turn per token, as render's: a second call waits for the first to be counted
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      const usd = await mayQueueAll(s, ctx, at, asked.map((x) => ({ recipe: x.recipe, input: x.input, takes: x.takes })), { machine, renders: asked.length * takes });
      const jobs = await renderClips(s, view.id, asked.map(({ id, input }) => ({ id, input, ...(takes > 1 ? { takes } : {}) })), machine?.id, { mcpToken: token.id });
      s.queue.events.emit("timeline");
      const numbers = asked.map((x) => view.clips.findIndex((c) => c.id === x.id) + 1);
      ctx.said(`Rendered ${plural(asked.length, "clip")} of “${view.name}”${takes > 1 ? `, ${takes} takes each` : ""}`);
      return {
        jobs, clips: numbers, takes, on: machine ? machineName(machine) : spends(ctx) ? "wherever the queue ends each first" : "the user's own machines (this token has no Spend)",
        ...(skipped.length ? { skipped } : {}), ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}),
      };
    });
  },
  task: (a: { jobs: string[] }) => ({ jobs: a.jobs }),
});

const useTake = tool({
  name: "use_take",
  scope: "make",
  title: "Use a take",
  description: "Make another of a clip's takes the one that plays (read_timeline › otherTakes), as clicking it in the editor's takes does. One step of Undo; the joins with its neighbours are said again by read_timeline.",
  input: { timeline: z.string().min(1), clip: clipRef, take: z.union([z.string().min(1), z.number().int().min(1)]).describe("The take's id, or its number among the clip's takes.") },
  async run(args, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, args.timeline);
    const { clip: c, i } = clipAt(view, args.clip);
    const take = typeof args.take === "number" ? c.takes[args.take - 1] : c.takes.find((x) => x.id === args.take);
    if (!take) throw httpError(`Clip ${i + 1} has no take ${args.take}: it has ${plural(c.takes.length, "take")}.`, 404);
    const n = c.takes.indexOf(take) + 1;
    if (c.take?.id === take.id) return { clip: i + 1, playing: `take ${n}`, said: "it was playing already" };
    await agentChange(s, ctx, view.id, () => s.timelines.editClip(c.id, { take: take.id }), (out) => (out ? `clip ${i + 1} plays take ${n}` : null));
    ctx.said(`Clip ${i + 1} of “${view.name}” plays take ${n}`);
    const now = clipAt(await s.timelines.view(view.id), c.id);
    return { clip: i + 1, playing: `take ${n}`, lengthMs: now.clip.lengthMs, join: now.clip.join };
  },
});

const finish = tool({
  name: "finish",
  scope: "make",
  title: "Finish",
  description: "The Finish dialog: each clip's playing take brought to its final quality as a new take marked as the finish of its draft (which stays among the takes): SeedVR2, RTX VSR or a pixel model on the take's video, H3's latent re-sample of the draft's own kept latent, or a Face refine. Clips finished already are skipped unless `redo`; each skipped clip is said with why. The same limits as render_clips: renders an hour, rented pods only with Spend.",
  input: {
    timeline: z.string().min(1),
    route: z.enum(["seedvr", "latent", "rtx", "model", "face"]),
    factor: z.number().min(1).max(4).default(2).describe("How many times larger (1 for a Face refine)."),
    clips: z.array(clipRef).optional().describe("Only these clips; left out: all."),
    redo: z.union([z.boolean(), z.literal("changed")]).optional().describe("Finish again the clips finished already: all (true), or those finished with other settings (\"changed\")."),
    colour: z.enum(["lab", "wavelet", "adain", "none"]).optional(),
    upscaleModel: z.string().max(200).optional().describe("The pixel model (route model)."),
    seedvrFrames: z.number().int().min(0).max(49).optional(),
    sharpen: z.number().min(0).max(1).optional(),
    latentNoise: z.number().min(0.05).max(0.95).optional().describe("H3's latent re-sample: the noise level (σ) it starts at, eased to 0 over its steps on a karras curve; 0.35 is the default."),
    latentSteps: z.number().int().min(1).max(6).optional().describe("Steps of the latent re-sample (3 by default)."),
    face: z.boolean().optional().describe("Face refine first, where the model offers it."),
    faceDenoise: z.number().min(0.3).max(0.6).optional(),
    faceModel: z.string().max(200).optional().describe(`Face refine's model, over each clip's own form's: an H3 diffusion model file, or "${OWN_MODEL}" (the model the clip is made with: nothing more loaded); another file is a second model to load. A SCAIL-2 or LTX 2.5 clip's faces are redrawn with the file picked too; their own model is not H3's, so "${OWN_MODEL}" is the fused turbo there, and the job says so. Left out: as each clip's form says (on SCAIL-2 and LTX 2.5, the fused turbo of Settings › Models when their form names none).`),
    latentModel: z.string().max(200).optional().describe("H3's latent upscaler file (route latent); left out: the one of Settings › Models. The re-sampling runs on the clip's own model."),
    seedvrModel: z.string().max(200).optional().describe("SeedVR2's model file, the 3B or the 7B (route seedvr); left out: the one of Settings › Models."),
  },
  async run({ timeline, ...args }, ctx) {
    const { s, token } = ctx;
    const view = await viewOf(s, timeline);
    const b = finishBody.parse({ ...args, clips: args.clips?.map((r) => clipAt(view, r).clip.id), redo: args.redo ?? false });
    const at = await seen(s);
    return oneAtATime(s.db, `mcp-render:${token.id}`, () => s.timelines.history.oneAtATime(`finish:${view.id}`, async () => {
      const { plan, skipped } = await finishPlan(s, view.id, b);
      if (!plan.length) throw httpError(`Nothing to finish on “${view.name}”: ${skipped.map((x) => `clip ${x.clip}: ${x.why}`).join("; ") || "no clip"}.`);
      const jobs = plan.flatMap((j) => (j.kind === "render" ? [{ recipe: j.recipe, input: j.input, takes: 1 }, ...(j.then ? [{ recipe: CUT_JOB, input: j.then.cut, takes: 1 }] : [])] : [{ recipe: CUT_JOB, input: j.cut, takes: 1 }]));
      const usd = await mayQueueAll(s, ctx, at, jobs, { renders: jobs.length });
      const done = await finishClips(s, plan, skipped, { mcpToken: token.id });
      s.queue.events.emit("timeline");
      ctx.said(`Finished ${plural(plan.length, "clip")} of “${view.name}” (${args.route})`);
      return { jobs: done.jobs, skipped: done.skipped.map((x) => `clip ${x.clip}: ${x.why}`), ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}) };
    }));
  },
  task: (a: { jobs: string[] }) => ({ jobs: a.jobs }),
});

const exportTool = tool({
  name: "export",
  scope: "make",
  title: "Export",
  description: "The timeline's Export: one video of it in the library, put together by ffmpeg (no model, no GPU). It waits in the queue behind the renders asked before it, its own clips' among them, as the editor's Export does; an export already on its way is answered rather than queued twice. read_timeline › export gives the item once it is done.",
  input: {
    timeline: z.string().min(1),
    scale: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional().describe("Enlarge every frame at the end (nothing is rendered again)."),
    fit: z.enum(["timeline", "largest"]).optional().describe("largest: at the size of the largest take (the finished ones)."),
    music: z.boolean().optional(),
    smooth: z.boolean().optional().describe("48 pictures a second, worked out from those there are. Slow."),
    range: z.strictObject({ inMs: z.number().min(0), outMs: z.number().min(0) }).optional().describe("Only this part of the timeline, on its clock (the music left out)."),
    blend: z.boolean().optional().describe("Crossfade a clip that extends the one before over the frames they share."),
    match: z.boolean().optional().describe("Nudge each clip's brightness and tint to the clip before at the join."),
    webMb: z.union([z.literal(10), z.literal(25)]).optional().describe("A copy for the web, under this many megabytes."),
  },
  async run({ timeline, ...opts }, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, timeline);
    const { id } = await exportTimeline(s, timeline, exportBody.parse(opts), { mcpToken: ctx.token.id });
    const waiting = view.clips.filter((c) => c.job).length;
    ctx.said(`Exported “${view.name}”`);
    return { job: id, ...(view.exporting?.id === id ? { said: "an export of it was on its way already: this is that one" } : {}), ...(waiting ? { waitsFor: `${plural(waiting, "clip")} rendering or in the queue` } : {}) };
  },
  task: (a: { job: string }) => ({ jobs: [a.job] }),
});

// ------------------------------------------------------------------------------------------------- In and Out, plans, masks, takes

/** What a regenerated or looped clip is pinned to, in the editor's words (timelineRange.ts RangeContext). */
const pinnedSaid = (x: { start: string; end: string }) => [
  x.start === "clip" ? "it carries on from the clip before" : x.start === "frame" ? "it opens on the frame before In" : null,
  x.end === "clip" ? "the clip after carries on from it" : x.end === "frame" ? "it ends on the frame at Out" : null,
].filter(Boolean).join("; ") || "nothing";

/**
 * The parts a slow motion of In–Out would slow, read before the timeline is changed: the video clips with a take under the
 * range, each with the stretch of its take that would be slowed. slowRangeOf makes the same ones (split at In and Out), so
 * the token's limits are asked for what will be queued, and a refusal leaves the timeline as it was.
 */
function slowParts(view: View, inMs: number, outMs: number, factor: 2 | 4) {
  return view.clips.flatMap((c) => {
    if (c.kind !== "video" || !c.take || c.atMs >= outMs || c.atMs + c.lengthMs <= inMs) return [];
    const startMs = Math.round(c.take.startMs + Math.max(0, inMs - c.atMs));
    const endMs = Math.round(c.take.startMs + Math.min(c.lengthMs, outMs - c.atMs));
    return [{ recipe: CUT_JOB, input: { asset: c.take.asset.id, startMs, endMs, action: "slow", factor }, takes: 1 }];
  });
}

const timelineRange = tool({
  name: "timeline_range",
  scope: "make",
  title: "In and Out",
  description: [
    "What the editor's In and Out do to the range between them, on the timeline's clock (read_timeline gives each clip's atMs and lengthMs): split (the clips under In and Out each become two there); remove (what plays between them goes, the clips after close the gap; undo brings it back);",
    "regenerate (the range replaced by a new clip to render, pinned to the frame before In and the frame at Out, on a model that takes them; In = Out on a cut puts a clip between the two); loop (a new clip after Out that returns to the frame at In, so that the range plays round). Both answer a clip that is not rendered: render_clips renders it, edit_clip changes its form first.",
    "copy (that part of the timeline as one video in the library, through the export queue: ffmpeg, no GPU); slow (factor 2 or 4: the range made clips of their own, each slowed video arriving as a new take of its clip; RIFE on the GPU where ComfyUI has it, so it is held to the token's limits as a render is: renders an hour, rented pods only with Spend and within its cap).",
    "Each change is a step of the timeline's Undo; an editor open on it shows it at once, with Undo.",
  ].join(" "),
  input: {
    timeline: z.string().min(1),
    action: z.enum(["split", "remove", "regenerate", "loop", "copy", "slow"]),
    inMs: z.number().min(0).describe("In, in ms on the timeline's clock."),
    outMs: z.number().min(0).describe("Out, likewise."),
    factor: z.union([z.literal(2), z.literal(4)]).optional().describe("Of slow: how many times slower (2 when left out)."),
    scale: z.number().min(1).max(2).optional().describe("Of copy: every frame enlarged this much."),
  },
  async run(args, ctx) {
    const { s, token } = ctx;
    const view = await viewOf(s, args.timeline);
    const body = timelineRangeBody.parse({ inMs: args.inMs, outMs: args.outMs, action: args.action, ...(args.factor ? { factor: args.factor } : {}), ...(args.scale ? { scale: args.scale } : {}) });
    const span = `${clockOf(args.inMs)}–${clockOf(args.outMs)}`;
    if (args.action === "copy") {
      const r = await rangeAction(s, view.id, body);
      ctx.said(`Copied ${span} of “${view.name}” to the library`);
      return { job: "job" in r ? r.job : null, said: "the range as one video in the library once the job is done (job follows it)" };
    }
    if (args.action === "slow") {
      const factor = args.factor ?? 2;
      const parts = slowParts(view, args.inMs, args.outMs, factor);
      const at = await seen(s);
      // the checks and the queueing in one turn per token, as render's: a slowed part is a render when RIFE makes it.
      // Nothing under the range is left to slowRangeOf to refuse in its own words
      return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
        const usd = parts.length ? await mayQueueAll(s, ctx, at, parts, { renders: parts.length }) : 0;
        const r = await agentChange(s, ctx, view.id, async () => (await rangeAction(s, view.id, body, { mcpToken: token.id })) as { clips: string[]; jobs: string[]; engine: string }, (out) => (out ? `${span} slowed ×${factor}` : null));
        ctx.said(`Slowed ${span} of “${view.name}” ×${factor}`);
        const now = await s.timelines.view(view.id);
        return {
          clips: r.clips.map((id) => now.clips.findIndex((c) => c.id === id) + 1), jobs: r.jobs,
          by: r.engine === "rife" ? "RIFE on the GPU" : "ffmpeg on this computer (this ComfyUI has no RIFE)",
          said: "each slowed video arrives as a new take of its clip; the joins into and out of the range are cuts now. undo takes the split back",
          on: spends(ctx) ? "wherever the queue ends each first" : "the user's own machines (this token has no Spend)",
          ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}),
        };
      });
    }
    // each of these is one step done whole or refused whole: nothing to say live when it is refused
    let said = "";
    let answer: Record<string, unknown> = {};
    await agentChange(s, ctx, view.id, async () => {
    const r = await rangeAction(s, view.id, body);
    if (args.action === "split") {
      said = `split at ${span}`;
      answer = { done: said };
    } else if (args.action === "remove") {
      said = `removed ${span}`;
      answer = { done: `${said}: the clips after closed the gap. undo brings it back` };
    } else {
      const made = r as { clip: string; context: { start: string; end: string }; widenedMs?: number; longerMs?: number };
      const n = (await s.timelines.view(view.id)).clips.findIndex((c) => c.id === made.clip) + 1;
      said = args.action === "loop" ? `clip ${n} loops back to ${clockOf(args.inMs)}` : `clip ${n} to render in place of ${span}`;
      answer = {
        clip: n, id: made.clip, pinned: pinnedSaid(made.context),
        ...(made.widenedMs ? { widenedMs: made.widenedMs, widened: "the range was widened to a length its model makes" } : {}),
        ...(made.longerMs ? { longerMs: made.longerMs, longer: "its model makes no clip that short: what follows it moved by that much" } : {}),
        said: `clip ${n} is new and not rendered: render_clips renders it (edit_clip changes its form first). undo takes it back`,
      };
    }
    }, () => said || null);
    ctx.said(`${args.action === "split" ? "Split" : args.action === "remove" ? "Removed" : args.action === "loop" ? "Looped" : "Regenerated"} ${span} of “${view.name}”`);
    return { ...answer, undo: (await s.timelines.history.last(view.id))?.label ?? null };
  },
});

const planClips = tool({
  name: "plan_clips",
  scope: "make",
  title: "Plan clips",
  description: "A scene written as several clips, as the designer's plan lays it: one new clip for each, at the end of the timeline, each carrying on from the one before, all in one form, each with its own texts (its prompt inputs by id → words: describe_form says which; you write them). Up to 12 at once. Nothing is rendered: render_clips does. One step of Undo for them all; an editor open on the timeline shows them at once, with Undo.",
  input: {
    timeline: z.string().min(1),
    form: z.string().min(1).describe("A form's id (list_forms)."),
    clips: z.array(z.record(z.string(), z.string())).min(1).max(12).describe("One per clip, in order: input id → its text."),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, args.timeline);
    const recipe = formOf(s, args.form);
    const at = await seen(s);
    // each text checked as the form checks it, before anything is made: a wrong id is refused with the form's inputs
    for (const texts of args.clips) await checkedValues(s, at, recipe, texts);
    let said = "";
    const { made, numbers } = await agentChange(s, ctx, view.id, async () => {
      const made = await s.timelines.planner.planClips(view.id, recipe.id, args.clips);
      const now = await s.timelines.view(view.id);
      const numbers = made.map((id) => now.clips.findIndex((c) => c.id === id) + 1);
      said = `planned ${plural(made.length, "clip")} (${numbers.length > 1 ? `clips ${numbers[0]}–${numbers.at(-1)}` : `clip ${numbers[0]}`})`;
      return { made, numbers };
    }, () => said || null);
    ctx.said(`Planned ${plural(made.length, "clip")} of ${recipe.title} on “${view.name}”`);
    return { clips: numbers, ids: made, said: `${said}, each carrying on from the one before: nothing rendered yet (render_clips renders them in order). undo takes them all back` };
  },
});

/** Frames of a mask video along it, to see: as many as it is long, a few. */
const MASK_FRAMES = 4;

const maskPreviewTool = tool({
  name: "mask_preview",
  scope: "make",
  title: "Show the mask",
  description: "A Swap character clip's Show the mask, as its panel's: the window's tracking and masks alone drawn over its frames, as a short video kept out of the library (gone after a day); no take is made. A job on the GPU, held to the token's limits as a render is (renders an hour, rented pods only with Spend and within its cap), with the clip's form as its Render would send it. Answers the job; called again with `job`, where it stands and, once it is done, frames of the mask video to see.",
  input: {
    timeline: z.string().min(1),
    clip: clipRef,
    job: z.string().optional().describe("A job this tool answered: where it stands, and its frames once done."),
  },
  async run(args, ctx) {
    const { s, token } = ctx;
    const view = await viewOf(s, args.timeline);
    const { clip: c, i } = clipAt(view, args.clip);
    if (args.job) {
      const r = await maskPreviewOf(s, args.job);
      const said = { job: args.job, clip: i + 1, status: r.status, ...(r.error ? { error: r.error } : {}) };
      if (!r.video) {
        ctx.said(`Followed the mask of clip ${i + 1} of “${view.name}”: ${r.status}`);
        return { ...said, ...(r.status === "done" ? { said: "it made no video" } : {}) };
      }
      const ms = r.video.durationMs ?? 0;
      const cells: Array<{ bytes: Uint8Array; label: string }> = [];
      for (let k = 0; k < MASK_FRAMES; k++) {
        const at = Math.round(((k + 0.5) / MASK_FRAMES) * ms);
        const bytes = await s.timelines.media.peek(r.video.id, at, SHEET_HEIGHT).catch(() => null);
        if (bytes) cells.push({ bytes, label: clockOf(at) });
      }
      const sheet = await contactSheet(cells, { height: SHEET_HEIGHT, perRow: MASK_FRAMES });
      const content: Content = [{ type: "text", text: JSON.stringify({ ...said, durationMs: ms, frames: cells.length }, null, 2) }];
      if (sheet) content.push({ type: "image", data: Buffer.from(sheet).toString("base64"), mimeType: "image/jpeg" });
      ctx.said(`Saw the mask of clip ${i + 1} of “${view.name}”`);
      return new Rich(content);
    }
    const recipe = c.recipe ? s.registry.recipe(c.recipe) : undefined;
    if (!recipe?.inputs.some((x) => x.id === "maskPreview")) throw httpError(`Clip ${i + 1} is not a swap's clip: only a Swap character clip has a mask to show.`);
    const at = await seen(s);
    const input = await formSent(s, at, recipe, c.inputs);
    // greyed in the panel as its Render is: a form not filled shows no mask either
    const why = whyNot(s, view, i, input);
    if (why) throw httpError(`Clip ${i + 1} cannot show its mask: ${why.why}.`);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      const usd = await mayQueueAll(s, ctx, at, [{ recipe: recipe.id, input: { ...input, maskPreview: true }, takes: 1 }], { renders: 1 });
      const { job } = await maskPreview(s, c.id, input, { mcpToken: token.id });
      ctx.said(`Showed the mask of clip ${i + 1} of “${view.name}”`);
      return {
        job, clip: i + 1, said: "mask_preview with this job says where it stands and shows its frames once it is done",
        on: spends(ctx) ? "wherever the queue ends it first" : "the user's own machines (this token has no Spend)",
        ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}),
      };
    });
  },
});

const removeTake = tool({
  name: "remove_take",
  scope: "make",
  title: "Remove a take",
  description: "Remove one of a clip's takes, as its takes' Remove does: the video rendered for it goes to the bin with it, unless it was brought in from the library, something else still uses it, or it is a file of a linked folder (those stay where they are). The newest of the other takes plays instead when it was playing. Refused for the draft of a finished take (remove the finish first). undo brings the take back and its video out of the bin; restore brings the video back to the library alone.",
  input: { timeline: z.string().min(1), clip: clipRef, take: z.union([z.string().min(1), z.number().int().min(1)]).describe("The take's id, or its number among the clip's takes.") },
  async run(args, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, args.timeline);
    const { clip: c, i } = clipAt(view, args.clip);
    const take = typeof args.take === "number" ? c.takes[args.take - 1] : c.takes.find((x) => x.id === args.take);
    if (!take) throw httpError(`Clip ${i + 1} has no take ${args.take}: it has ${plural(c.takes.length, "take")}.`, 404);
    const n = c.takes.indexOf(take) + 1;
    await agentChange(s, ctx, view.id, async () => {
      await s.timelines.removeTake(take.id);
      return true;
    }, (out) => (out ? `removed take ${n} of clip ${i + 1}` : null));
    // removeTake says nothing of the video: whether it went to the bin is read from it
    const binned = Boolean((await s.db.selectFrom("assets").select("deleted_at").where("id", "=", take.asset.id).executeTakeFirst())?.deleted_at);
    const now = clipAt(await s.timelines.view(view.id), c.id).clip;
    ctx.said(`Removed take ${n} of clip ${i + 1} of “${view.name}”${binned ? ": its video to the bin" : ""}`);
    return {
      removed: `take ${n} of clip ${i + 1}`,
      video: binned ? `${take.asset.id} went to the bin: restore brings it back to the library (not onto the clip)` : `${take.asset.id} stays in the library (brought in from it, used elsewhere, or a linked folder's file)`,
      playing: now.take ? `take ${now.takes.findIndex((x) => x.id === now.take!.id) + 1} of ${now.takes.length}` : "no take: the clip has nothing rendered now",
      undo: "undo brings the take back, and its video out of the bin",
    };
  },
});

const binUnusedTakes = tool({
  name: "bin_unused_takes",
  scope: "make",
  title: "Bin the unused takes",
  description: "The timeline's unused takes go, their videos to the bin with them, as its Bin unused takes does: the takes no clip plays and nothing needs (not a draft a kept take was finished from or carries on from, nor a video another clip, timeline, person, preset or waiting job uses, nor a linked folder's file). Answers how many went and the space their videos take. One step: undo brings the takes back and their videos out of the bin; restore brings a video back to the library alone, until the user empties the bin.",
  input: { timeline: z.string().min(1) },
  async run({ timeline }, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, timeline);
    const r = await agentChange(s, ctx, view.id, () => s.timelines.binUnusedTakes(view.id), (out) => (out?.binned ? `binned ${plural(out.binned, "unused take")}` : null));
    if (!r.binned) {
      ctx.said(`Looked for unused takes on “${view.name}”: none`);
      return { binned: 0, said: "no take of this timeline is unused: nothing went" };
    }
    ctx.said(`Binned ${plural(r.binned, "unused take")} of “${view.name}”`);
    return { binned: r.binned, bytes: r.bytes, mb: Math.round(r.bytes / 2 ** 20), said: `${plural(r.binned, "take")} went, ${r.binned > 1 ? "their videos" : "its video"} to the bin. undo brings ${r.binned > 1 ? "them" : "it"} back; restore brings a video back to the library alone` };
  },
});

const duplicateTimeline = tool({
  name: "duplicate_timeline",
  scope: "make",
  title: "Duplicate a timeline",
  description: "A copy of a timeline beside it (its project and folder), as its menu's Duplicate does: its clips with their forms, joins and transitions, their takes (the same videos of the library, playing in both), its music, source and recordings. Not its Undo history, its jobs or its last export. To try a change on the copy and keep the original as it is. Answers the copy's id and name.",
  input: { timeline: z.string().min(1), name: z.string().trim().max(200).optional().describe("The copy's name; left out: \"<its name> copy\".") },
  async run(a, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, a.timeline);
    const made = await s.timelines.duplicate(view.id, a.name);
    ctx.said(`Duplicated “${view.name}” as “${made.name}”`);
    return { id: made.id, name: made.name, project: made.projectId, clips: made.clips.length };
  },
});

const deleteTimeline = tool({
  name: "delete_timeline",
  scope: "make",
  title: "Delete a timeline",
  description: "Delete a timeline, as its menu's Delete does: the sequence goes with its Undo history; the videos of its takes stay in the library. It does not come back (no bin, no undo): duplicate_timeline first to keep a copy. Refused while a clip of it is in the queue. `name` is the timeline's name as read_timeline gives it, to be sure of which one goes.",
  input: { timeline: z.string().min(1), name: z.string().min(1).max(200).describe("Its name, exactly: a check that this is the one meant.") },
  async run(a, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, a.timeline);
    if (a.name.trim() !== view.name.trim()) throw httpError(`Timeline ${view.id} is ${quoted(view.name)}, not ${quoted(a.name)}: nothing was deleted.`);
    const busy = await s.db.selectFrom("jobs").select("id").where("timeline_id", "=", view.id).where("status", "in", ["queued", "running"]).executeTakeFirst();
    if (busy) throw httpError(`A clip of ${quoted(view.name)} is in the queue: cancel it or wait for it, then delete.`, 409);
    await s.timelines.remove(view.id);
    ctx.said(`Deleted the timeline ${quoted(view.name)}`);
    return { deleted: view.id, name: view.name, said: "Its takes' videos stay in the library." };
  },
});

// ------------------------------------------------------------------------------------------------- seeing, undoing

type Content = CallToolResult["content"];
/** How tall each frame of a contact sheet is. */
const SHEET_HEIGHT = 180;
/** Frames in a row of a contact sheet. */
const PER_ROW = 6;
/** At most this many clips on one sheet: a longer timeline is seen in parts (`from`). */
const SHEET_CLIPS = 24;

const viewTimeline = tool({
  name: "view_timeline",
  scope: "look",
  title: "View a timeline",
  description: "A timeline as a contact sheet you can see: one frame of each clip (the middle of what plays, labelled with its number), or with `joins` the last frame before each join and the first after it (labelled 2→3), with each join's facts (hard cut or seamless, follows on or stale, its transition). Clips with nothing rendered show no frame. Up to 24 clips at a time: `from` starts further on.",
  input: {
    timeline: z.string().min(1),
    joins: z.boolean().optional().describe("Frames around each join, rather than one per clip."),
    from: z.number().int().min(1).optional().describe("The first clip shown (1 when left out)."),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const view = await viewOf(s, args.timeline);
    const start = (args.from ?? 1) - 1;
    const shown = view.clips.slice(start, start + SHEET_CLIPS);
    const frameOf = async (c: ClipView, ms: "middle" | "start" | "end"): Promise<Uint8Array | null> => {
      if (c.kind === "still") {
        if (!c.still) return null;
        return s.timelines.media.peek(c.still.id, 0, SHEET_HEIGHT).catch(() => null);
      }
      if (!c.take) return null;
      const at = ms === "start" ? c.take.startMs + 20 : ms === "end" ? Math.max(c.take.startMs, c.take.endMs - 60) : (c.take.startMs + c.take.endMs) / 2;
      return s.timelines.media.peek(c.take.asset.id, Math.round(at), SHEET_HEIGHT).catch(() => null);
    };
    const cells: Array<{ bytes: Uint8Array; label: string }> = [];
    const facts: unknown[] = [];
    if (args.joins) {
      for (const [k, c] of shown.entries()) {
        const i = start + k;
        const before = view.clips[i - 1];
        if (!before) continue;
        const [a, b] = await Promise.all([frameOf(before, "end"), frameOf(c, "start")]);
        if (a) cells.push({ bytes: a, label: `${i}→` });
        if (b) cells.push({ bytes: b, label: `→${i + 1}` });
        facts.push({ join: `${i}→${i + 1}`, joined: c.joined === "continue" ? "seamless" : "hard cut", state: c.join ?? "not rendered yet", ...(c.transition ? { transition: c.transition } : {}), frames: a && b ? "both" : a ? `clip ${i + 1} has no frame yet` : b ? `clip ${i} has no frame yet` : "neither has a frame yet" });
      }
    } else {
      for (const [k, c] of shown.entries()) {
        const bytes = await frameOf(c, "middle");
        if (bytes) cells.push({ bytes, label: String(start + k + 1) });
        facts.push({ clip: start + k + 1, kind: c.kind, lengthMs: c.lengthMs, ...(bytes ? {} : { frame: c.job ? "rendering" : "nothing rendered yet" }), ...(k || start ? { join: c.joined === "continue" ? `seamless, ${c.join ?? "not rendered yet"}` : c.transition ? `hard cut, ${c.transition.kind}` : "hard cut" } : {}) });
      }
    }
    const sheet = await contactSheet(cells, { height: SHEET_HEIGHT, perRow: args.joins ? 2 * Math.floor(PER_ROW / 2) : PER_ROW });
    const text = { timeline: view.name, clips: view.clips.length, shown: shown.length ? `clips ${start + 1}–${start + shown.length}` : "none", ...(view.clips.length > start + SHEET_CLIPS ? { more: `from: ${start + SHEET_CLIPS + 1} shows the next ones` } : {}), facts };
    const content: Content = [{ type: "text", text: JSON.stringify(text, null, 2) }];
    if (sheet) content.push({ type: "image", data: Buffer.from(sheet).toString("base64"), mimeType: "image/jpeg" });
    ctx.said(`Viewed “${view.name}”${args.joins ? "'s joins" : ""}: ${plural(cells.length, "frame")}`);
    return new Rich(content);
  },
});

const undo = tool({
  name: "undo",
  scope: "make",
  title: "Undo",
  description: "The timeline's own Undo: its last change taken back (whoever made it, the user or an agent), with what it took back. Refused over a clip in the queue that the step would take away or change, as the editor's is. A take rendered since stays in the library and comes back with redo.",
  input: { timeline: z.string().min(1) },
  async run({ timeline }, ctx) {
    const view = await viewOf(ctx.s, timeline);
    const { label, said } = await ctx.s.timelines.history.undo(timeline);
    ctx.said(`Undid ${label} on “${view.name}”`);
    return { undone: label, ...(said ? { said } : {}) };
  },
});

const redo = tool({
  name: "redo",
  scope: "make",
  title: "Redo",
  description: "The timeline's own Redo: what Undo last took back done again, until the next change.",
  input: { timeline: z.string().min(1) },
  async run({ timeline }, ctx) {
    const view = await viewOf(ctx.s, timeline);
    const { label, said } = await ctx.s.timelines.history.redo(timeline);
    ctx.said(`Redid ${label} on “${view.name}”`);
    return { redone: label, ...(said ? { said } : {}) };
  },
});

export const TIMELINE_TOOLS = [listTimelines, readTimeline, viewTimeline, newTimeline, editTimeline, editClip, renderClipsTool, useTake, finish, exportTool, undo, redo, timelineRange, planClips, maskPreviewTool, removeTake, binUnusedTakes, duplicateTimeline, deleteTimeline];
