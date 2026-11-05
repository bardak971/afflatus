import { carryOver, CUT_WINDOW, joinFrames, joinWay, madeAroundRecording, plural, recordingParts, recordingSpecOf, trimIn, trimOut, type ClipGrid, type CutMarks, type InputSpec, type Recipe } from "@afflatus/core";
import { CutError } from "./cut";
import { now, type Db } from "./db";
import { httpError } from "./errors";
import { clipColumns, takeColumns } from "./timelineHistory";
import type { TimelineMedia } from "./timelineMedia";
import type { AssetRow, ClipRow, Placed, TakeRow, TimelineCore, TimelineRow, Tx } from "./timelineModel";
import { ownInputIds, settingsOf, type NewClip, type TimelinePlan } from "./timelinePlan";
import { aroundRemoved, foldParts, keptAround, removedOf, removedView, type ParkedClip, type RemovedPart } from "./timelineRemoved";

/** What a recording's clips ask of the model besides its core (Timelines): the clips in the queue. */
export interface RecordingTimelines {
  busyOf(ids: string[], db?: Db): Promise<Set<string>>;
}

/**
 * A voice recording laid on the track as Lip sync clips: made from it, trimmed, cut again, given a form, and what it is cut
 * at; and the model made around a recording that its clips are made in.
 */
export class TimelineRecording {
  constructor(private readonly core: TimelineCore, private readonly planner: TimelinePlan, private readonly media: TimelineMedia, private readonly timelines: RecordingTimelines) {}

  /**
   * A voice recording dropped on the track made into Lip sync clips: cut (recordingParts) into parts of about `seconds` (5
   * by default) ± `window` (CUT_WINDOW), at a pause, a lyric line's end or the quietest moment there, within what one clip takes, one clip a part, each carrying on from the one before. In place of
   * the empty clip it was dropped on, else after the last clip. The model is the one whose form takes a recording laid on a
   * clip's sound part by part (H3 · Lip sync), with the settings of the last clip of it. One step for Undo; nothing renders.
   * A clip in the queue is never replaced (dropped on, or made anew over a moved start): refused, as its render would land
   * on no clip.
   */
  async makeFromRecording(timelineId: string, o: { asset: string; clip?: string; seconds?: number; window?: number; fromS?: number; toS?: number; replace?: string[]; label?: string; keepCut?: boolean }): Promise<string[]> {
    const sound = await this.core.assetRow(o.asset);
    if (!sound || (sound.kind !== "audio" && sound.kind !== "video") || !sound.duration_ms) throw httpError("A recording has to be a sound (or a video's sound) of the library.");
    if (sound.kind === "video" && !sound.has_sound) throw httpError("That video has no sound: a recording has to be a sound, or a video with sound.");
    const marks = await this.cutMarksOf(sound);
    const ids = await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      const all = await this.core.placed(timelineId);
      // the empty clip it was dropped on: the clips go in its place, with what was written in it (its scene). `replace`: the
      // clips of the recording made anew in their place (its start moved)
      const gone = o.replace ?? (o.clip && all.some((p) => p.clip.id === o.clip && !p.clip.take_id && p.clip.kind === "video") ? [o.clip] : []);
      refuseBusy(gone, await this.timelines.busyOf(gone), all, o.replace ? "move the recording's start" : "drop a recording on it");
      // a re-cut or a moved start keeps each clip's form where its part survives (card #72): the clips it replaces, as they lie
      const was = o.replace ? all.filter((p) => o.replace!.includes(p.clip.id)).map((p) => this.partOfClip(p)) : [];
      const cut = cutOf(recordingCuts(await this.core.row(timelineId)), sound.id);
      // the form its new parts take (card #2): its New clips form, else Lip sync of the family of the clip it was dropped on,
      // replaces or comes after (an LTX clip makes LTX clips), kept as its New clips form so that its panel says it
      const near = all.find((p) => p.clip.id === gone[0]) ?? all.filter((p) => p.clip.kind === "video" && p.clip.recipe_id).at(-1);
      const form = this.newClipsForm(cut.form, near?.clip.recipe_id);
      // `fromS` to `toS`: the stretch of the recording its clips are made of (a recording trimmed: trimRecording), all of it by
      // default, cut to what one clip of that form holds
      // made anew over its clips (a re-cut, a moved start): around the parts removed from their middle, which stay removed
      // with their takes, each kept with the first clip after it, a cut (card #114). One kept with a clip a trim set aside,
      // or before the new start, goes (the editor asks first when it holds takes)
      const fromS = o.fromS ?? 0;
      const toS = o.toS ?? sound.duration_ms! / 1000;
      const among = new Set(o.replace ?? []);
      const removed = o.replace ? (removedRecordings(t)[sound.id] ?? []).filter((p) => among.has(p.before)) : [];
      const spanOf = this.recordingSpan();
      const { pieces } = aroundRemoved(fromS * 1000, toS * 1000, removed.map((part) => ({ part, ...removedView(part, spanOf) })));
      const fits = recordingSpecOf(form.inputs)!.window.fits;
      // each part ends where a clip of the form can (ClipGrid): the first carries on from the clip before as recordingClipsIn
      // will make it (its run-up, and its own moment before the words), or opens on a cut; one after a part removed, on a cut
      const index = gone.length ? all.findIndex((p) => gone.includes(p.clip.id)) : all.length;
      const left = all.filter((p) => !gone.includes(p.clip.id));
      const firstOpensCut = this.opensOnCut(index > 0 ? left[index - 1] : undefined, form);
      const firstForm = was.find((c) => c.from <= fromS * 1000 + 1 && c.to > fromS * 1000)?.inputs ?? settingsOf(form, all, index);
      const cutUp = pieces.map((piece, k) => {
        const opensCut = k > 0 || piece.after.length > 0 || firstOpensCut;
        const grid = this.clipGridOf(form, opensCut, k === 0 ? firstForm : {});
        return this.recordingPartsOf(fits, marks, piece.fromMs / 1000, piece.toMs / 1000, o.seconds, o.window, grid).map((p, i) => ({ ...p, ...(i === 0 && (k > 0 || piece.after.length) ? { cut: true } : {}) }));
      });
      const parts = cutUp.flat();
      if (!parts.length) throw httpError("The recording is too short for a clip.");
      return this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, o.label ?? `the ${plural(parts.length, "clip")} made from the recording`, undefined, tx);
        const made = await this.recordingClipsIn(tx, timelineId, sound, parts, { gone, was, form: form.id });
        if (cut.form !== form.id && !o.keepCut) await setRecordingCut(tx, timelineId, sound.id, { ...cut, form: form.id });
        // made anew over a moved start: what a trim had set aside of it no longer fits its clips
        if (o.replace?.length) {
          let at = 0;
          const firsts = cutUp.map((p) => (p.length ? made[(at += p.length) - p.length]! : null));
          const { kept } = keptAround(pieces, firsts, (part, before) => ({ before, rows: part.rows, joined: part.joined, take: null }));
          await setParkedRecording(tx, timelineId, sound.id, [], null, kept);
        }
        // cut again at another length (the recording's panel): kept for its trims, which cut what they add the same way
        if (o.keepCut) await setRecordingCut(tx, timelineId, sound.id, { ...cut, form: form.id, seconds: o.seconds ?? DEFAULT_CUT.seconds, window: o.window ?? DEFAULT_CUT.window });
        return made;
      });
    });
    await this.core.touch(timelineId);
    return ids;
  }

  /**
   * What a recording is cut at: its pauses and timed lines, read once and kept beside it (TimelineMedia.pauses), and its
   * loudness (the voice band's, else the whole sound's), kept as its curve on the track is. A sound ffmpeg could not read
   * is said as such; its loudness not measured, a part with no pause or line in its window ends at the length asked.
   */
  private async cutMarksOf(sound: AssetRow): Promise<CutMarks> {
    const { pauses, lines } = await this.media.pauses(sound.id).catch((err: Error) => {
      throw err instanceof CutError ? httpError(`The recording's sound could not be read (${err.message}).`) : err;
    });
    const levels = await this.media.motion(sound.id, sound).then((m) => {
      const db = m.speech ?? m.sound;
      return db?.length ? { rate: m.rate, db } : null;
    }, () => null);
    return { pauses, lines, levels };
  }

  /**
   * The parts `fromS` to `toS` of a recording is cut into for the Lip sync model's clips (recordingParts), about `seconds`
   * each, within `window` of that, each ending where a clip of the form can (`grid`, clipGridOf).
   */
  private recordingPartsOf(fits: VoiceWindow["fits"], marks: CutMarks, fromS: number, toS: number, seconds = DEFAULT_CUT.seconds, window = DEFAULT_CUT.window, grid?: ClipGrid) {
    return recordingParts({ fromS, toS, wantS: seconds, ...this.clipBounds(fits), ...marks, windowS: window, ...(grid ? { clipGrid: grid } : {}) });
  }

  /**
   * Where a clip of `form` can end (core ClipGrid): its model's frame counts, less the run-up it carries on from (the form's
   * own, or `first`'s: the settings its first clip is made with), and for the first part its moment before the words too,
   * which the clip plays before its part as it plays the run-up. None when `opensCut`: the first then plays from its start.
   * Undefined for a form with no frame grid.
   */
  private clipGridOf(form: Recipe<any>, opensCut: boolean, first: Record<string, unknown> = {}): ClipGrid | undefined {
    const { fps, frameGrid } = form.traits ?? {};
    const fits = recordingSpecOf(form.inputs)?.window.fits;
    if (!fps || !frameGrid) return undefined;
    const head = joinFrames(form, "previous", first);
    const given = (id: string) => {
      const spec = form.inputs.find((i) => i.id === id);
      return Number(first[id] ?? (spec && "default" in spec ? spec.default : 0)) || 0;
    };
    const lead = Math.round((fits?.less ?? []).reduce((sum, id) => sum + given(id), 0) * fps);
    return { fps, grid: frameGrid, head, firstHead: (opensCut ? 0 : head) + lead };
  }

  /** Whether a clip of `form` placed after `before` opens on a cut (nothing to carry on from, or a form it cannot carry on from), as recordingClipsIn makes its first. */
  private opensOnCut(before: Placed | undefined, form: Recipe<any>): boolean {
    return !before || before.clip.kind !== "video" || !before.clip.recipe_id || joinWay(this.core.registry.recipe(before.clip.recipe_id), form) === "cut";
  }

  /** The fewest and most seconds of a recording one Lip sync clip takes. */
  clipBounds(fits: VoiceWindow["fits"]) {
    return { leastS: fits?.min ?? 1, mostS: fits ? fits.frames / fits.fps - (fits.pad ?? 0) : 15 };
  }

  /**
   * The clips of these parts of a recording, written in the transaction given: in place of the clips `gone` (the first of
   * them), else after `after`, else at the end. Each part is made in the form of the clip it replaces whose part it overlaps
   * most (`was`: a re-cut keeps a clip's form and its settings where its part survives, card #72), else in the recording's
   * New clips form (`form`, Lip sync by default), with what was written in the clip it replaces (its shared inputs across a
   * change of form, its seed on the first: writtenIn), or the settings of the clip it follows when it is of that form, else
   * of the last clip of it; the first carrying on from the clip before when it can.
   */
  private async recordingClipsIn(tx: Db, timelineId: string, sound: AssetRow, parts: Array<{ start: number; seconds: number; cut?: boolean }>, at: { gone: string[]; after?: string; was?: ClipPart[]; form?: string }): Promise<string[]> {
    const { spec } = this.recordingModel();
    const { gone, after } = at;
    const all = await this.core.placed(timelineId, tx);
    const replaced = gone.length ? all.findIndex((p) => gone.includes(p.clip.id)) : -1;
    const index = replaced >= 0 ? replaced : after ? all.findIndex((p) => p.clip.id === after) + 1 : all.length;
    const model = replaced >= 0 ? all[replaced] : after ? all.find((p) => p.clip.id === after) : undefined;
    const fresh = this.newClipsForm(at.form, model?.clip.recipe_id);
    const ofPart = new Set([spec.id, spec.window.start, spec.window.seconds, "seed"]);
    // the clips it replaces taken out, the new ones go where the first of them was: the clip before is the one just ahead
    const left = all.filter((p) => !gone.includes(p.clip.id));
    const before = index > 0 ? left[index - 1] : undefined;
    const order: Array<{ clip: { id: string } }> = left.map((p) => ({ clip: { id: p.clip.id } }));
    if (gone.length) await tx.deleteFrom("clips").where("id", "in", gone).execute();
    const made: string[] = [];
    for (const [k, part] of parts.entries()) {
      const from = part.start * 1000;
      const to = (part.start + part.seconds) * 1000;
      const overlap = (c: ClipPart) => Math.min(to, c.to) - Math.max(from, c.from);
      const survives = (at.was ?? []).reduce<ClipPart | undefined>((best, c) => (overlap(c) > 0 && (!best || overlap(c) > overlap(best)) ? c : best), undefined);
      const recipe = (survives && this.holdsRecording(survives.recipe) ? this.core.registry.recipe(survives.recipe) : undefined) ?? fresh;
      const own = ownInputIds(recipe);
      // the clip dropped on hands what was written in it over in any form; one it comes after, only in its own
      const kept = survives?.recipe === recipe.id ? survives.inputs : model && (replaced >= 0 || model.clip.recipe_id === recipe.id) ? this.writtenIn(model, recipe) : {};
      // the first part takes the place of the clip dropped on and keeps its seed; the others draw their own
      const seed = k === 0 && !survives && replaced >= 0 && "seed" in kept ? { seed: kept.seed } : {};
      const form = { ...Object.fromEntries(Object.entries({ ...settingsOf(recipe, all, index), ...kept }).filter(([key]) => own.has(key) && !ofPart.has(key))), ...seed };
      // the first carries on from the clip before when it can (H3 to Lip sync: in the latent), else it starts on its own
      // one after a part removed (`cut`: made anew around it) meets nothing before it: a cut
      const opens = part.cut || (k === 0 && this.opensOnCut(before, recipe));
      const clip: NewClip = {
        kind: "video", recipeId: recipe.id, joined: opens ? "cut" : "continue", still: null, take: null, asset: undefined, look: null,
        inputs: { ...form, [spec.id]: sound.id, [spec.window.start]: part.start, [spec.window.seconds]: part.seconds },
      };
      const id = await this.planner.insertClip(timelineId, order, index + k, clip, tx, false);
      order.splice(index + k, 0, { clip: { id } });
      made.push(id);
    }
    // the clips after them moved along once, all the parts in
    await this.core.renumber(timelineId, order.map((p) => p.clip.id), tx);
    await this.core.keep(sound.id, tx);
    return made;
  }

  /**
   * What was written in a clip (its scene, model, LoRAs, seed…) that a clip of `recipe` made in its place keeps: all of it in
   * the same form; across a change of form (a recording dropped on LTX · Video with audio makes LTX · Lip sync, card #2) the
   * inputs both forms have, as the studio carries them when its operation changes (carryOver); into another family only the
   * prompts, its model and LoRAs being of no use there.
   */
  private writtenIn(model: Placed, recipe: Recipe<any>): Record<string, unknown> {
    const inputs = JSON.parse(model.clip.inputs) as Record<string, unknown>;
    if (model.clip.recipe_id === recipe.id) return inputs;
    const from = model.clip.recipe_id ? this.core.registry.recipe(model.clip.recipe_id) : undefined;
    if (!from) return {};
    const carried = carryOver(from, recipe, inputs, undefined);
    if (from.family === recipe.family) return carried;
    const prompts = new Set(recipe.inputs.filter((i) => i.type === "prompt").map((i) => i.id));
    return Object.fromEntries(Object.entries(carried).filter(([id]) => prompts.has(id)));
  }

  /** A clip under a recording as a re-cut reads it: its part of the recording in ms, its form and what it was given. */
  private partOfClip(p: Placed): ClipPart {
    const { spec } = this.recordingModel();
    const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
    const from = Number(inputs[spec.window.start]) * 1000;
    return { from, to: from + Number(inputs[spec.window.seconds]) * 1000, recipe: p.clip.recipe_id ?? "", inputs };
  }

  /** A clip under a recording set aside, its part of it in ms (removedView's reading). */
  recordingSpan() {
    const w = this.recordingModel().spec.window;
    return (row: ParkedClip) => {
      const inputs = JSON.parse(String(row.clip.inputs)) as Record<string, unknown>;
      return { from: Number(inputs[w.start]) * 1000, to: (Number(inputs[w.start]) + Number(inputs[w.seconds])) * 1000 };
    };
  }

  /**
   * The model whose form is made around a recording laid on a clip's sound part by part (H3 · Lip sync), and that input:
   * a dropped recording's clips are made in it. Its input's ids are those of every form a clip under a recording takes.
   */
  recordingModel() {
    const recipe = this.core.registry.recipes().find((r) => r.output === "video" && madeAroundRecording(r.inputs));
    const spec = recipe && recordingSpecOf(recipe.inputs);
    if (!recipe || !spec) throw httpError("No model on this Afflatus makes a clip around a recording (MiniMax H3 · Lip sync).");
    return { recipe, spec };
  }

  /**
   * The form a recording's new clips are made in: its New clips form (card #72), else the form made around a recording of the
   * family of `near`, the clip it was dropped on or comes after (card #2: LTX's Lip sync after an LTX clip), else the first
   * model made around one (H3 · Lip sync).
   */
  private newClipsForm(form: string | undefined, near: string | null | undefined): Recipe<any> {
    if (form && this.holdsRecording(form)) return this.core.registry.recipe(form)!;
    const family = near ? this.core.registry.recipe(near)?.family : undefined;
    const own = family ? this.core.registry.recipes().find((r) => r.family === family && r.output === "video" && madeAroundRecording(r.inputs)) : undefined;
    return own ?? this.recordingModel().recipe;
  }

  /** What one clip of a recording's New clips form holds of it: the cuts, re-cuts and longer Outs cut their new parts to it. */
  private async newClipsFits(timelineId: string, asset: string, near?: string | null) {
    const form = this.newClipsForm(cutOf(recordingCuts(await this.core.row(timelineId)), asset).form, near);
    return recordingSpecOf(form.inputs)!.window.fits;
  }

  /** Whether a clip in this form can be under a recording (card #72): made around it (Lip sync), or one it plays over (Video with audio). */
  holdsRecording(recipeId: string | null | undefined): boolean {
    const recipe = recipeId ? this.core.registry.recipe(recipeId) : undefined;
    return Boolean(recipe && recordingSpecOf(recipe.inputs));
  }

  /**
   * The recording a clip is under: its recording input set, whatever its form, as long as the form takes one (card #72).
   * Its model changed between Lip sync and Video with audio, it stays one of the recording's; leaving it is Remove.
   */
  recordingUnder(clip: { recipe_id?: unknown; inputs?: unknown }): string | undefined {
    const recipe = typeof clip.recipe_id === "string" ? this.core.registry.recipe(clip.recipe_id) : undefined;
    const spec = recipe && recordingSpecOf(recipe.inputs);
    const asset = spec ? (JSON.parse(String(clip.inputs)) as Record<string, unknown>)[spec.id] : undefined;
    return typeof asset === "string" && asset ? asset : undefined;
  }

  /**
   * A recording's Lip sync clips trimmed (the rethink's trim, for recordings): the stretch of it they are made of, its In
   * and Out in ms of the recording. The same rule as the source's windows (trimSource, trimIn):
   * - Its end in: the clips past it set aside (an end out brings them back); an empty clip it falls in is shortened to it,
   *   or set aside when what is left is under the fewest seconds a clip takes; a rendered clip, or one in the queue, is
   *   never shortened: the end snaps to its nearer end, never back before the clip kept before it. The first clip always
   *   stays. A clip in the queue is never set aside: refused. The clip shortened keeps its length before (under the
   *   recordings' `shortened`), given back by the end out, or when it is set aside after all, as the source's windows do.
   * - Its end out (trimOut): the clips set aside back as they were while the stretch holds them (one not held yet stops the
   *   end there, kept aside), then new clips, cut at its pauses, after the last one, none shorter than a clip takes; one
   *   step for Undo, one transaction.
   * - Its start moved: its clips made anew over the new stretch, around the parts removed from it (makeFromRecording; the
   *   editor asks first when that leaves rendered takes).
   * Read and written in the timeline's turn (trimSource says why). Returns the clips added, and where the end came to rest.
   */
  async trimRecording(timelineId: string, to: { asset: string; fromMs: number; toMs: number }): Promise<{ clips: string[]; toMs: number }> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    const sound = await this.core.assetRow(to.asset);
    const length = sound?.duration_ms ?? 0;
    if (!sound || !length) throw httpError("A recording has to be a sound of the library.");
    // what it is cut at read before the timeline is held (the first time, ffmpeg reads the whole sound): in the turn, read back
    const marks = await this.cutMarksOf(sound);
    const out = await this.core.oneAtATime(timelineId, async () => {
      const all = await this.core.placed(timelineId);
      const mine = all.filter((p) => this.recordingUnder(p.clip) === to.asset);
      if (!mine.length) throw httpError("No clip of this timeline is made of that recording.");
      const part = (clip: { inputs?: unknown }) => {
        const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
        const start = Number(inputs[w.start]) * 1000;
        return { start, end: start + Number(inputs[w.seconds]) * 1000, inputs };
      };
      const curFrom = Math.round(part(mine[0]!.clip).start);
      const curTo = Math.round(part(mine.at(-1)!.clip).end);
      const fromMs = Math.max(0, Math.min(length - 1000, Math.round(to.fromMs)));
      let toMs = Math.max(fromMs + 1000, Math.min(length, Math.round(to.toMs)));
      const busy = await this.timelines.busyOf(mine.map((p) => p.clip.id));
      // cut as its panel set it: the parts a trim adds or makes anew are of the same length and window, and as long as
      // one clip of its New clips form holds
      const cutAs = cutOf(recordingCuts(await this.core.row(timelineId)), to.asset);
      const fits = await this.newClipsFits(timelineId, to.asset, mine.at(-1)!.clip.recipe_id);
      if (Math.abs(fromMs - curFrom) > 20) {
        const clips = await this.makeFromRecording(timelineId, { asset: to.asset, fromS: fromMs / 1000, toS: toMs / 1000, seconds: cutAs.seconds, window: cutAs.window, replace: mine.map((p) => p.clip.id), label: "the recording's start moved" });
        return { clips, toMs };
      }
      if (Math.abs(toMs - curTo) <= 20) return { clips: [], toMs: curTo };
      if (toMs > curTo) {
        // an empty last clip first made longer toward where the first clip set aside starts (its end had been brought in to
        // the trim), then those set aside back as they were while the stretch holds them, then new clips at its pauses past
        // them, none shorter than a clip can be (trimOut). Worked out first, then written in one transaction: one step for Undo
        const { mostS } = this.clipBounds(fits);
        const row = await this.core.row(timelineId);
        const parked = parkedRecordings(row)[to.asset] ?? [];
        // the clips set aside with a part removed before them, kept removed (foldParts): they come back past it
        const cuts = new Set((removedRecordings(row)[to.asset] ?? []).map((p) => p.before));
        let shortened = shortenedRecordings(row)[to.asset];
        const last = mine.at(-1)!;
        const lastPart = part(last.clip);
        const first = parked[0] ? part(parked[0].clip) : undefined;
        // as far as the first clip set aside starts, else (none set aside) its own length before a trim in shortened it
        const before = shortened?.clip === last.clip.id ? lastPart.start + shortened.seconds * 1000 : undefined;
        // never across a part kept removed: the first clip set aside then starts past that part, and growing up to it would
        // play the removed words in the empty last clip
        const pastRemoved = parked[0] ? cuts.has(String(parked[0].clip.id)) : false;
        const reach = last.clip.take_id || pastRemoved ? undefined : first ? ((first.start - lastPart.start) / 1000 <= mostS ? first.start : undefined) : before;
        const grow = trimOut({ start: lastPart.start, end: curTo, free: !last.clip.take_id && !busy.has(last.clip.id), reach }, parked.map((p) => ({ ...part(p.clip), fits: true, taken: p.takes.length > 0, cut: cuts.has(String(p.clip.id)) })), toMs, { fromMs: curFrom, leastMs: (fits?.min ?? 1) * 1000, mostMs: mostS * 1000 });
        const { back } = grow;
        const end = Math.round(grow.end);
        // the new parts carry on from the clip before them: each ends where a clip of the New clips form can (clipGridOf)
        const grid = this.clipGridOf(this.newClipsForm(cutAs.form, mine.at(-1)!.clip.recipe_id), false);
        const parts = grow.more && toMs > end + 50 ? this.recordingPartsOf(fits, marks, end / 1000, toMs / 1000, cutAs.seconds, cutAs.window, grid) : [];
        if (grow.lastEnd === undefined && !back && !parts.length) return { clips: [], toMs: curTo };
        const after = back ? String(parked[back - 1]!.clip.id) : last.clip.id;
        const rest = grow.keep ? parked.slice(back) : [];
        const clips = await this.core.db.transaction().execute(async (tx) => {
          await this.core.remember(timelineId, "the recording made longer", undefined, tx);
          const order = all.map((p) => p.clip.id);
          if (grow.lastEnd !== undefined) {
            // as long as it was before (its own figure, not one rounded back from ms), or as far as the stretch goes
            const whole = before !== undefined && grow.lastEnd >= before - 1;
            await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...lastPart.inputs, [w.seconds]: whole ? shortened!.seconds : Math.round(grow.lastEnd - lastPart.start) / 1000 }), updated_at: now() }).where("id", "=", last.clip.id).execute();
            if (whole) shortened = undefined;
          }
          let at = order.indexOf(last.clip.id) + 1;
          for (const row of parked.slice(0, back)) {
            await unparkClip(tx, row);
            order.splice(at++, 0, String(row.clip.id));
          }
          await this.core.renumber(timelineId, order, tx);
          const made = parts.length ? await this.recordingClipsIn(tx, timelineId, sound, parts, { gone: [], after, form: cutAs.form }) : [];
          await setParkedRecording(tx, timelineId, to.asset, rest, shortened ?? null);
          return made;
        });
        return { clips, toMs: parts.length ? toMs : end };
      }
      const cut = trimIn(mine.map((p) => ({ id: p.clip.id, from: part(p.clip).start, ...part(p.clip), whole: Boolean(p.clip.take_id) || busy.has(p.clip.id), busy: busy.has(p.clip.id) })), toMs, (fits?.min ?? 1) * 1000);
      refuseBusy(cut.away, busy, all, "trim the recording's end before it");
      toMs = cut.toMs;
      if (!cut.away.length && !cut.shortened.length && Math.abs(toMs - curTo) <= 20) return { clips: [], toMs: curTo };
      await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, "the recording made shorter", undefined, tx);
        const row = await tx.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
        let shortened = shortenedRecordings(row)[to.asset];
        // the clip shortened by this trim, if any: its length before kept (the first, when it is shortened again), as the
        // source's windows keep theirs (trimSource), once those set aside have their length back
        let fresh: typeof shortened;
        for (const s of cut.shortened) {
          const { inputs } = part(mine.find((p) => p.clip.id === s.id)!.clip);
          if (shortened?.clip !== s.id) fresh = { clip: s.id, seconds: Number(inputs[w.seconds]) };
          await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...inputs, [w.seconds]: Math.round(s.ms) / 1000 }), updated_at: now() }).where("id", "=", s.id).execute();
        }
        // set aside whole, in order, before those set aside already (they lie further on): the end out brings them back. A
        // clip shortened before is set aside at its length before, as it lay among them, unless it was rendered since
        // (atLengthBefore). A part removed before one of them goes back among them, end to end (foldParts)
        const { rows, parts } = foldParts(removedRecordings(row)[to.asset] ?? [], cut.away, await parkClips(tx, cut.away));
        shortened = atLengthBefore(rows, shortened, w.seconds);
        if (fresh) shortened = fresh;
        await setParkedRecording(tx, timelineId, to.asset, [...rows, ...(parkedRecordings(row)[to.asset] ?? [])], shortened ?? null, parts);
        if (cut.away.length) await this.core.renumber(timelineId, all.map((p) => p.clip.id).filter((id) => !cut.away.includes(id)), tx);
      });
      return { clips: [], toMs };
    });
    await this.core.touch(timelineId);
    return out;
  }

  /**
   * A recording's clips cut again (its panel's Clip length ± its window): made anew over the stretch they use, about
   * `seconds` each, within `window` of that, as a moved start makes them, the parts removed from it kept removed (the editor asks first when that leaves
   * rendered takes behind); the cut kept, so its trims cut what they add the same way. One step for Undo.
   */
  async cutRecording(timelineId: string, o: { asset: string; seconds: number; window: number }): Promise<{ clips: string[] }> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    const { leastS, mostS } = this.clipBounds(await this.newClipsFits(timelineId, o.asset));
    const seconds = Math.min(Math.max(o.seconds, leastS), mostS);
    const clips = await this.core.oneAtATime(timelineId, async () => {
      const mine = await this.recordingClipsOf(timelineId, o.asset);
      const part = (inputs: Record<string, unknown>) => ({ start: Number(inputs[w.start]), end: Number(inputs[w.start]) + Number(inputs[w.seconds]) });
      const fromS = part(mine[0]!.inputs).start;
      const toS = part(mine.at(-1)!.inputs).end;
      return this.makeFromRecording(timelineId, { asset: o.asset, fromS, toS, seconds, window: Math.max(0, o.window), replace: mine.map((c) => c.id), label: "the recording cut again", keepCut: true });
    });
    return { clips };
  }

  /**
   * What a recording's clips share, given to all of them at once (its panel's Shared by its clips): any setting of the Lip
   * sync form but the recording itself, each clip's part of it and its seed; null takes it away. One step for Undo. Their
   * takes stay; their next ones are made with it.
   */
  async recordingForm(timelineId: string, o: { asset: string; inputs: Record<string, unknown> }): Promise<Array<{ id: string; inputs: Record<string, unknown> }>> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    // any setting of a form a clip under a recording takes; each clip is given those its own form has (card #72)
    const forms = this.core.registry.recipes().filter((r) => r.output === "video" && recordingSpecOf(r.inputs));
    const shared = new Set(forms.flatMap((r) => r.inputs).filter((i) => i.type !== "clip" && i.id !== spec.id && i.id !== w.start && i.id !== w.seconds && i.id !== "seed").map((i) => i.id));
    const given = Object.entries(o.inputs).filter(([k]) => shared.has(k));
    if (!given.length) throw httpError("Nothing the recording's clips can share was given.");
    let written: Array<{ id: string; inputs: Record<string, unknown> }> = [];
    await this.core.oneAtATime(timelineId, async () => {
      const mine = await this.recordingClipsOf(timelineId, o.asset);
      const changed = mine.flatMap((c) => {
        const next = { ...c.inputs };
        const own = new Set((c.recipe ? this.core.registry.recipe(c.recipe)?.inputs ?? [] : []).map((i) => i.id));
        for (const [k, v] of given) {
          if (!own.has(k)) continue;
          if (v === null || v === undefined) delete next[k];
          else next[k] = v;
        }
        return JSON.stringify(next) === JSON.stringify(c.inputs) ? [] : [{ id: c.id, next }];
      });
      if (!changed.length) return;
      written = changed.map((c) => ({ id: c.id, inputs: c.next }));
      await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, "the recording's clips changed together", undefined, tx);
        for (const c of changed) await tx.updateTable("clips").set({ inputs: JSON.stringify(c.next), updated_at: now() }).where("id", "=", c.id).execute();
      });
    });
    await this.core.touch(timelineId);
    // the clips' forms as written: the editor's edits over them become these (a clip typed in before kept its old text)
    return written;
  }

  /**
   * The form a recording's new clips are made in (its panel's New clips, card #72): a re-cut's parts no clip had, a longer
   * Out's. One of the forms a clip under a recording takes; one step for Undo. The clips it has keep theirs.
   */
  async recordingNewClips(timelineId: string, o: { asset: string; recipe: string }): Promise<void> {
    if (!this.holdsRecording(o.recipe)) throw httpError(`That model does not go under a recording: ${this.formsUnderRecording()} do.`);
    await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      await this.recordingClipsOf(timelineId, o.asset);
      await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, "the form of the recording's new clips", undefined, tx);
        await setRecordingCut(tx, timelineId, o.asset, { ...cutOf(recordingCuts(t), o.asset), form: o.recipe });
      });
    });
    await this.core.touch(timelineId);
  }

  /**
   * The forms a clip under a recording takes, named as the editor's model list names them, with their family ("MiniMax H3 ·
   * Lip sync, MiniMax H3 · Video with audio and Wan 2.2 · Video": Wan's title alone says no model).
   */
  formsUnderRecording(): string {
    // the form a recording is made around first, as the editor lists them
    const forms = this.core.registry.recipes().filter((r) => r.output === "video" && recordingSpecOf(r.inputs));
    const named = (r: Recipe<any>) => `${this.core.registry.family(r.family)?.name ?? r.family} · ${r.title}`;
    const titles = [...forms.filter((r) => madeAroundRecording(r.inputs)), ...forms.filter((r) => !madeAroundRecording(r.inputs))].map(named);
    return titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : (titles[0] ?? "none");
  }

  /** A recording's clips on a timeline, whatever their form, in order, with their forms read; none is refused. */
  private async recordingClipsOf(timelineId: string, asset: string) {
    const mine = (await this.core.placed(timelineId))
      .filter((p) => this.recordingUnder(p.clip) === asset)
      .map((p) => ({ id: p.clip.id, recipe: p.clip.recipe_id, inputs: JSON.parse(p.clip.inputs) as Record<string, unknown> }));
    if (!mine.length) throw httpError("No clip of this timeline is made of that recording.");
    return mine;
  }
}

/** The window of a model's recording input (H3 · Lip sync's): where in the sound a clip's part starts, how long it lasts, what one clip holds. */
export type VoiceWindow = NonNullable<Extract<InputSpec, { type: "audio" }>["window"]>;

/**
 * Refused (409) when a clip about to be set aside or replaced has a render or a finish queued or under way: its render would
 * land on no clip, its video kept by nothing, and on a rented GPU paid for all the same. `what`: what the user was doing.
 */
export function refuseBusy(ids: string[], busy: Set<string>, all: Placed[], what: string) {
  const hit = ids.find((id) => busy.has(id));
  if (hit) throw httpError(`Clip ${all.findIndex((p) => p.clip.id === hit) + 1} is rendering or in the queue: let it end, or stop it, to ${what}.`, 409);
}

/** These clips set aside, in their order, and taken off the timeline (their takes go with them, kept in what is returned). */
export async function parkClips(tx: Tx, ids: string[]): Promise<ParkedClip[]> {
  const rows: ParkedClip[] = [];
  for (const id of ids) {
    const clip = await tx.selectFrom("clips").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    const takes = await tx.selectFrom("takes").selectAll().where("clip_id", "=", id).execute();
    rows.push({ clip: clip as unknown as Record<string, unknown>, takes: takes as unknown as Array<Record<string, unknown>> });
  }
  if (ids.length) await tx.deleteFrom("clips").where("id", "in", ids).execute();
  return rows;
}

/**
 * The clip a trim in shortened before (`shortened`), set aside whole by a deeper one (among `rows`): set aside at its
 * length before, as it lay among those set aside further on. Set aside short, it no longer met the next one, and the end
 * out dropped that one and every one after it, rendered or not. Not when it was rendered since: its takes were made at
 * the shorter length, which it keeps (given back, it came back longer than the take playing on it, and the clip after it
 * was placed for a part that take does not reach), and the end out stops at it, as at any rendered clip that does not
 * meet the next (trimOut). The record is spent either way: returns what is left of it. `seconds`: the input of its length.
 */
export function atLengthBefore(rows: ParkedClip[], shortened: Shortened | undefined, seconds: string): Shortened | undefined {
  const row = shortened && rows.find((p) => p.clip.id === shortened.clip);
  if (!shortened || !row) return shortened;
  if (!row.takes.length) row.clip = { ...row.clip, inputs: JSON.stringify({ ...(JSON.parse(String(row.clip.inputs)) as Record<string, unknown>), [seconds]: shortened.seconds }) };
  return undefined;
}

/**
 * A clip set aside back as it was, with its takes and the one that played (its place in the order is the caller's). Only
 * the columns a clip and a take have now, as Undo puts them back. A take whose video was erased meanwhile stays out (the
 * clip comes back without it, as Undo's does: it would fail the take's tie to its video, and with it every trim out after);
 * one whose video is in the bin brings it back out.
 */
export async function unparkClip(tx: Tx, row: ParkedClip) {
  const { take_id: takeId, ...clip } = clipColumns(row.clip as unknown as ClipRow);
  const takes = row.takes.map((t) => takeColumns(t as unknown as TakeRow));
  const there = takes.length ? new Set((await tx.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
  const kept = takes.filter((t) => there.has(t.asset_id));
  await tx.insertInto("clips").values({ ...clip, take_id: null }).execute();
  for (const take of kept) await tx.insertInto("takes").values(take).execute();
  if (kept.length) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", kept.map((t) => t.asset_id)).where("deleted_at", "is not", null).execute();
  const playing = kept.some((t) => t.id === takeId) ? takeId : kept.at(-1)?.id;
  if (playing) await tx.updateTable("clips").set({ take_id: playing }).where("id", "=", clip.id).execute();
}

/** What a trim set aside of each of a timeline's recordings, by recording asset. */
export function parkedRecordings(t: TimelineRow): Record<string, ParkedClip[]> {
  try {
    const read = JSON.parse(t.recordings ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(read).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as ParkedClip[]).filter((p) => p && typeof p.clip === "object" && Array.isArray(p.takes))]));
  } catch {
    return {};
  }
}

/** A clip a trim in shortened, and its length before (in seconds), for the end out to give it back. */
type Shortened = { clip: string; seconds: number };
/** Where the recordings' shortened clips are kept, in the same JSON: no recording is named so (asset ids are hex). */
const SHORTENED = "shortened";

/** The clip of each of a timeline's recordings that a trim in shortened, by recording asset. */
export function shortenedRecordings(t: TimelineRow): Record<string, Shortened> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[SHORTENED];
    if (!read || typeof read !== "object") return {};
    return Object.fromEntries(Object.entries(read as Record<string, Partial<Shortened>>).filter(([, v]) => typeof v?.clip === "string" && typeof v.seconds === "number")) as Record<string, Shortened>;
  } catch {
    return {};
  }
}

/**
 * What is set aside of one recording, written back (none: its entry goes), with its clip a trim in shortened (null: none;
 * left out: as it is).
 */
export async function setParkedRecording(db: Db | Tx, timelineId: string, asset: string, rows: ParkedClip[], shortened?: Shortened | null, removed?: RemovedPart[]) {
  const t = await db.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
  const map: Record<string, unknown> = parkedRecordings(t);
  const short = shortenedRecordings(t);
  const cuts = recordingCuts(t);
  const parts = removedRecordings(t);
  if (rows.length) map[asset] = rows;
  else delete map[asset];
  if (shortened) short[asset] = shortened;
  else if (shortened === null) delete short[asset];
  if (removed?.length) parts[asset] = removed;
  else if (removed) delete parts[asset];
  if (Object.keys(short).length) map[SHORTENED] = short;
  if (Object.keys(cuts).length) map[CUTS] = cuts;
  if (Object.keys(parts).length) map[REMOVED] = parts;
  await db.updateTable("timelines").set({ recordings: Object.keys(map).length ? JSON.stringify(map) : null }).where("id", "=", timelineId).execute();
}

/** Where the recordings' removed parts are kept (timelineRemoved.ts), in the same JSON: no recording is named so. */
const REMOVED = "removed";

/** The parts cut out of the middle of each of a timeline's recordings by removing their clips, by recording asset. */
export function removedRecordings(t: TimelineRow): Record<string, RemovedPart[]> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[REMOVED];
    if (!read || typeof read !== "object") return {};
    return Object.fromEntries(Object.entries(read as Record<string, unknown>).map(([k, v]) => [k, removedOf(v)] as const).filter(([, v]) => v.length));
  } catch {
    return {};
  }
}

/** How a recording is cut into clips, as its panel sets it: about `seconds` a clip, ± `window` (0: exactly that). */
type RecordingCut = { seconds: number; window: number; form?: string };
/** A clip under a recording as a re-cut reads it (TimelineRecording.partOfClip). */
type ClipPart = { from: number; to: number; recipe: string; inputs: Record<string, unknown> };
/** A recording cut as it is dropped: about 5 s a clip, ± CUT_WINDOW. */
const DEFAULT_CUT: RecordingCut = { seconds: 5, window: CUT_WINDOW };
/** Where the recordings' cuts are kept, in the same JSON as what a trim set aside (asset ids are hex: none is named so). */
const CUTS = "cut";

/** Each recording's cut set in its panel, by recording asset (those cut as dropped have none). */
export function recordingCuts(t: TimelineRow): Record<string, RecordingCut> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[CUTS];
    if (!read || typeof read !== "object") return {};
    // kept before the window (Snap to pauses, card #130): snapped reads as the window a recording is dropped with, unsnapped as 0
    return Object.fromEntries(Object.entries(read as Record<string, Partial<RecordingCut> & { snap?: boolean }>).flatMap(([k, v]) => {
      if (typeof v?.seconds !== "number") return [];
      const window = typeof v.window === "number" ? v.window : typeof v.snap === "boolean" ? (v.snap ? CUT_WINDOW : 0) : null;
      return window === null ? [] : [[k, { seconds: v.seconds, window, ...(typeof v.form === "string" ? { form: v.form } : {}) }] as const];
    }));
  } catch {
    return {};
  }
}

/** One recording's cut: as its panel set it, else as it was dropped. */
export function cutOf(cuts: Record<string, RecordingCut>, asset: string): RecordingCut {
  return cuts[asset] ?? DEFAULT_CUT;
}

/** One recording's cut written back, beside what a trim set aside of the recordings (left as it is). */
async function setRecordingCut(db: Db | Tx, timelineId: string, asset: string, cut: RecordingCut) {
  const t = await db.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
  let map: Record<string, unknown> = {};
  try {
    map = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>) ?? {};
  } catch {
    // unreadable: written anew with the cut alone
  }
  map[CUTS] = { ...recordingCuts(t), [asset]: cut };
  await db.updateTable("timelines").set({ recordings: JSON.stringify(map) }).where("id", "=", timelineId).execute();
}
