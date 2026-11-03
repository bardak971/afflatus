import type { ComponentProps } from "react";
import { api, type Clip } from "../api";
import { carriedOf, windowBounds, windowEndOn, windowPlaysSeconds } from "@afflatus/core";
import type { Track } from "./Track";
import type { LoadedEditor } from "./useTimelineEditor";
import { madeFromSource, sourceDropClip, windowed } from "./track/SourceLane";
import { SOURCE_LANDED, type ClipSource } from "./inspector/clipSource";
import { landedSaid } from "./inspector/clipLength";

// What the parts of the editor that show the timeline's source are drawn with (useEditorSource's `sourceLane`): its lane
// on the track, and a window clip's Source chapter. editorProps.tsx hands them over with the rest.

/** The source lane's part of the track: a video dropped on it, the lane clicked, dragged, split, its model's name. */
export function trackSourceProps(e: LoadedEditor): Pick<ComponentProps<typeof Track>, "onSource" | "sourceSelected" | "onSelectSource" | "onOpenSource" | "onRemoveSource" | "onStretchSource" | "sourcePlace" | "onPeekSource" | "sourceMode" | "sourceLabel" | "onSplitSource"> {
  return {
    onSource: (asset) => {
      // the model the windows are made with: that of an empty clip given one that makes a source window by window (the one
      // selected, else the first), so a model picked on a new clip before the source is dropped is the one its windows get,
      // its windows then in its place; else the source's model before; else the one the recipes name as a source's default
      // (the swap)
      const of = (id: string | null | undefined) => e.videoRecipes.find((r) => r.id === id && windowed(r));
      const chosen = sourceDropClip(e.t, e.videoRecipes, e.selection.current);
      const model = of(chosen?.recipe) ?? of(e.t.source?.recipe) ?? e.videoRecipes.find((r) => r.traits?.windows?.sourceDefault && windowed(r));
      if (!model) {
        e.edit.mutate({ source: { asset } });
        return e.selection.openSource();
      }
      const source = { asset, recipe: model.id, ...(chosen ? { clip: chosen.id } : {}) };
      // a model with a Picture of its own (Motion transfer) waits for it in the source panel; a swap has no source form (the
      // owner, 2026-10-18): dropped, the video is made into its clips at once, nothing rendered, the first opened
      if (model.inputs.some((i) => i.type === "image" && i.role === "source")) {
        e.edit.mutate({ source });
        return e.selection.openSource();
      }
      e.edit.mutate({ source }, { onSuccess: () => e.sourceLane.makeSource.run(false) });
    },
    sourceSelected: e.selection.sourceOpen,
    // the source plays on the stage, as ever; once made, the column shows no form of its own but the clip made from it
    // where the playhead stands (else its first), its form every clip's (the owner, 2026-10-18)
    onSelectSource: () => {
      const made = e.sourceLane.place?.made ? madeFromSource(e.t, e.videoRecipes) : [];
      e.selection.openSource();
      if (!made.length) return;
      const at = e.playhead.cursor ?? e.playhead.clock.get();
      e.selection.setSelected((made.find((c) => at >= c.atMs && at < c.atMs + c.lengthMs) ?? made[0]!).id);
    },
    onOpenSource: e.setOpened,
    onRemoveSource: e.sourceLane.removeSource,
    // before Make its settings; after Make a trim (windows set aside or made anew: useTimelineEditor's stretch)
    onStretchSource: (fromMs, toMs) => e.sourceLane.stretch.run(fromMs, toMs),
    sourcePlace: e.sourceLane.place,
    onPeekSource: (ms) => {
      // the stage turns to the source as soon as it is dragged: its frame there shows as it moves
      if (ms !== null && !e.selection.sourceOpen) e.selection.openSource();
      e.sourceLane.setSourcePeek(ms);
    },
    sourceMode: e.selection.sourceOpen && Boolean(e.sourceLane.place),
    sourceLabel: (() => {
      const r = e.videoRecipes.find((x) => x.id === e.t.source?.recipe);
      return r ? e.recipes.data?.families.find((f) => f.id === r.family)?.name ?? r.title : undefined;
    })(),
    onSplitSource: e.t.source && e.sourceLane.place && !e.sourceLane.place.made
      ? () => {
          const place = e.sourceLane.place!;
          const source = e.t.source!;
          // where the playhead stands on the source: the stage plays it in the track's own time
          const at = (e.selection.sourceOpen ? e.playhead.cursor ?? e.playhead.clock.get() : e.playhead.cursor ?? -1) - place.atMs;
          if (at <= source.fromMs + 200 || at >= source.toMs - 1000) {
            e.setNote("Put the playhead inside the source's stretch (click the source lane: the stage plays it) to split it there.");
            return;
          }
          e.sourceLane.splitSource.mutate(at);
        }
      : undefined,
  };
}

/**
 * The windows a source made, said as the recording's clips are: each one's length (what it plays, its take's once rendered),
 * and what each end but the last landed on (windowEndOn), counted. Null while the source's pauses are read.
 */
function sourceCutSaid(e: LoadedEditor, made: Clip[], source: NonNullable<LoadedEditor["t"]["source"]>, fps: number, step: number): { landed: string | null; lengths: number[] } {
  const parts = made.map((c) => {
    const recipe = e.videoRecipes.find((r) => r.id === c.recipe);
    const inputs = e.inputsOf(c);
    const w = windowed(recipe, inputs);
    // where its own frames start: past the run-up of a window that carries on
    const from = (w ? Number(inputs[w.start] ?? 0) * 1000 : 0) + (c.joined === "continue" && recipe ? (carriedOf(recipe, inputs) * 1000) / fps : 0);
    const plays = c.lengthMs > 0 ? c.lengthMs : ((recipe ? windowPlaysSeconds(recipe, inputs, c.joined) : null) ?? 0) * 1000 - (c.hiddenMs ?? 0);
    return { endMs: from + plays, plays };
  });
  const marks = source.withinMs > 0 ? e.sourceLane.sourceMarks : {};
  const landed = marks ? landedSaid(parts.slice(0, -1).map((p, k) => windowEndOn(p.endMs, made[k + 1]!.joined === "cut", marks, source.withinMs, (step * 1000) / fps / 2)), SOURCE_LANDED) : null;
  return { landed, lengths: parts.map((p) => p.plays / 1000) };
}

/** A clip made from the timeline's source, as its panel takes it: its Source chapter and where a change goes. */
export function clipSourceOf(e: LoadedEditor, current: Clip): ClipSource | undefined {
  const source = e.t.source;
  const made = source ? madeFromSource(e.t, e.videoRecipes) : [];
  if (!source || !made.some((c) => c.id === current.id)) return undefined;
  const w = windowed(e.videoRecipes.find((r) => r.id === current.recipe), source?.inputs);
  const driving = w ? e.videoRecipes.find((r) => r.id === current.recipe)?.inputs.find((i) => i.id === w.driving) : undefined;
  const patchClip = (share: "inLine" | "toAll") => void e.save(current.id).then(() => e.patch.mutate({ clip: current.id, patch: { share } }));
  const recipe = e.videoRecipes.find((r) => r.id === current.recipe);
  const runUp = recipe?.traits?.windows?.runUp;
  const own = recipe?.traits?.windows?.own ?? [];
  const ownOf = (c: Clip) => JSON.stringify(own.map((k) => e.inputsOf(c)[k] ?? null));
  const ask = e.sourceLane.sourceForm.ask;
  return {
    source,
    // every window the source made, in order, as the Source chapter lists them (the mock's "each window's own")
    list: made.map((c) => {
      const inputs = e.inputsOf(c);
      return {
        id: c.id,
        number: e.clips.indexOf(c) + 1,
        startMs: w ? Number(inputs[w.start] ?? 0) * 1000 : 0,
        seconds: w ? Number(inputs[w.seconds] ?? 0) : 0,
        opens: c.joined === "cut",
        // each window's own form among the grid's (card #42): Swap character, Motion transfer
        form: e.videoRecipes.find((r) => r.id === c.recipe)?.title ?? "",
        carried: recipe ? carriedOf(recipe, inputs) : 0,
        own: c !== made[0] && ownOf(c) !== ownOf(made[0]!),
        rendered: Boolean(c.take),
      };
    }),
    onSelectWindow: e.selection.select,
    runUp: runUp ? { counts: runUp.counts, value: recipe ? carriedOf(recipe, e.inputsOf(current)) : runUp.counts[0]!, on: (n: number) => e.sourceLane.cutSource.run({ inputs: { ...source.inputs, [runUp.input]: String(n) } }) } : null,
    stretchAsk: e.sourceLane.stretch.ask ? { ...e.sourceLane.stretch.ask, change: () => e.sourceLane.stretch.run(e.sourceLane.stretch.ask!.fromMs, e.sourceLane.stretch.ask!.toMs, true), keep: e.sourceLane.stretch.keep } : null,
    onUses: (fromMs, toMs) => e.sourceLane.stretch.run(fromMs, toMs),
    trimming: e.sourceLane.stretch.pending,
    cutAsk: e.sourceLane.cutSource.ask ? { rendered: e.sourceLane.cutSource.ask.rendered, change: () => e.sourceLane.cutSource.run(e.sourceLane.cutSource.ask!.change, true), keep: e.sourceLane.cutSource.keep } : null,
    formAsk: ask ? { title: e.videoRecipes.find((r) => r.id === ask.recipe)?.title ?? ask.recipe, rendered: ask.rendered, windows: ask.windows, change: () => e.sourceLane.sourceForm.run(ask.recipe, true), keep: e.sourceLane.sourceForm.keep } : null,
    count: made.length,
    first: made[0]?.id === current.id,
    apart: source.apart?.[current.id] ?? [],
    takesPick: driving?.type === "clip" && Boolean(driving.pick),
    // the window lengths the model takes, on the slider's steps (as the source panel had them)
    windows: (() => {
      const b = w ? windowBounds(w.shape) : { leastMs: 1000, mostMs: 5000 };
      const leastMs = Math.max(1000, Math.ceil(b.leastMs / 100) * 100);
      return { leastMs, mostMs: Math.max(leastMs, Math.floor(b.mostMs / 100) * 100) };
    })(),
    onCut: e.sourceLane.cutSource.run,
    ...sourceCutSaid(e, made, source, w?.shape.fps ?? 24, w?.shape.grid?.step ?? 4),
    mask: (() => {
      const asked = e.sourceLane.masks[current.id];
      const d = asked ? e.sourceLane.maskOfCurrent.data : undefined;
      const status: "none" | "waiting" | "ready" | "failed" = !asked ? "none" : !d || d.status === "queued" || d.status === "running" ? "waiting" : d.status === "done" && d.video ? "ready" : "failed";
      return { status, error: d?.error ?? null, shown: Boolean(asked?.shown) };
    })(),
    onShowMask: () => {
      // the form as a render sends it, saved first; the stage turns to the source, the clip's panel kept beside it
      const input = e.ready(current).input;
      if (!input) return;
      void e.save(current.id).then(() => api.maskPreview(current.id, input)).then((r) => {
        e.sourceLane.setMasks((m) => ({ ...m, [current.id]: { job: r.job, shown: true } }));
        e.selection.openSource();
        e.selection.setSelected(current.id);
      });
    },
    onMaskShown: (on) => {
      e.sourceLane.setMasks((m) => (m[current.id] ? { ...m, [current.id]: { ...m[current.id]!, shown: on } } : m));
      if (on) {
        e.selection.openSource();
        e.selection.setSelected(current.id);
      }
    },
    cutting: e.sourceLane.cutSource.pending,
    picking: e.sourceLane.whoPicking,
    onPicking: e.sourceLane.setWhoPicking,
    onClearPick: () => e.edit.mutate({ source: { pick: null } }),
    kept: e.keptToClip(current.id),
    onKept: (on) => e.keepToClip(current.id, on),
    onInLine: () => patchClip("inLine"),
    onToAll: () => patchClip("toAll"),
  };
}
