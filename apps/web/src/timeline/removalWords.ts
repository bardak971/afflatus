import { carriedOf } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline } from "../api";
import { clock, plural, seconds } from "../format";
import { recordingInput } from "./track/RecordingBand";
import { madeFromSource, windowed } from "./track/SourceLane";

/**
 * What removing clips does to a recording or the source they are made of, said before it is done (card #75, the owner:
 * explain it). A clip removed cuts its part out of it, as the server does it (Timelines.removeClips): the first ones as the
 * In moved past them, the last ones as the Out brought in before them, a run of them in the middle set aside, the clip
 * after it a cut. Null when none of the clips is part of one (or all of one go): those are removed as before, unasked.
 */
export function removalAsk(t: Timeline, recipes: RecipeInfo[], ids: string[], o: { range?: boolean } = {}): { title: string; text: string; help: string; yes: string } | null {
  const gone = new Set(ids);
  const one = ids.length === 1;
  const number = (id: string) => t.clips.findIndex((c) => c.id === id) + 1;
  const lines: string[] = [];
  for (const run of runsOf(t, recipes)) {
    const kept = run.clips.filter((c) => !gone.has(c.id));
    if (!kept.length || kept.length === run.clips.length) continue;
    const first = run.clips.indexOf(kept[0]!);
    const last = run.clips.indexOf(kept.at(-1)!);
    const lead = run.clips.slice(0, first);
    const tail = run.clips.slice(last + 1);
    const name = `“${run.name}”`;
    const span = (cs: Clip[]) => seconds(run.span(cs.at(-1)!).to - run.span(cs[0]!).from);
    if (lead.length) {
      lines.push(`${clipsSaid(lead, number)} ${lead.length > 1 ? "are" : "is"} the first of ${name}: In moves to ${at(run.span(kept[0]!).from)}, past ${lead.length > 1 ? "their" : "its"} ${span(lead)}.${run.kind === "source" && t.source?.pick ? " Who the swap replaces is clicked again on the new first frame." : ""}`);
      // the clip first now opens it as the first removed did: its take, made carrying on from them, opens on their frames
      if (kept[0]!.take && kept[0]!.joined === "continue") lines.push(carriesOn(number(kept[0]!.id), number(lead.at(-1)!.id)));
    }
    for (let k = first; k <= last; k++) {
      if (!gone.has(run.clips[k]!.id) || gone.has(run.clips[k - 1]!.id)) continue;
      let end = k;
      while (gone.has(run.clips[end + 1]!.id)) end++;
      const block = run.clips.slice(k, end + 1);
      const before = run.clips[k - 1]!;
      const after = run.clips[end + 1]!;
      const n = number(after.id);
      const several = block.length > 1;
      const which = one ? "" : ` (${clipsSaid(block, number).toLowerCase()})`;
      lines.push(`${several ? "Their" : "Its"} ${span(block)} of ${name} ${several ? "are" : "is"} cut out${which}: ${run.what} jumps from ${at(run.span(before).to)} to ${at(run.span(block.at(-1)!).to)}, and clip ${n} starts after a cut instead of carrying on. The part is set aside with its takes: Bring back on its mark puts it back.`);
      // its take was rendered carrying on from the clip removed: the frames it opens on were that clip's
      if (after.take && after.joined === "continue") lines.push(carriesOn(n, number(block.at(-1)!.id)));
      k = end;
    }
    if (tail.length) lines.push(`${clipsSaid(tail, number)} ${tail.length > 1 ? "are" : "is"} the last of ${name}: Out moves to ${at(run.span(kept.at(-1)!).to)}, before ${tail.length > 1 ? "their" : "its"} ${span(tail)}. Set aside with ${tail.length > 1 ? "their" : "its"} takes, ${tail.length > 1 ? "they come" : "it comes"} back when Out is moved out again.`);
  }
  if (!lines.length) return null;
  return {
    title: o.range ? "Remove the range?" : one ? `Remove clip ${number(ids[0]!)}?` : `Remove ${plural(ids.length, "clip")}?`,
    text: [...lines, "Undo brings it all back."].join("\n"),
    help: "A ripple delete, as in a video editor: a clip of a recording or of the source takes its part of it away, and the clips after it close the gap. Taken from the middle, the part is kept aside with its takes, marked on the band or the Source lane where it was cut (Bring back puts it back); the clip after it no longer carries on from what came before, so it starts on its own. The first or last clip moves In or Out instead, as trimming them would.",
    yes: o.range ? "Remove range" : one ? "Remove" : `Remove ${plural(ids.length, "clip")}`,
  };
}

/**
 * The clips In / Out's Remove range takes off whole, as the server finds them (TimelineRange.cutOut): those inside the
 * range, those it leaves less than a tenth of a second of, and one not laid out yet (no take) standing inside it. None
 * when the range is inside one clip: that one is split, not removed.
 */
export function rangeRemoves(clips: Pick<Clip, "id" | "atMs" | "lengthMs">[], a: number, b: number): string[] {
  const EDGE = 100;
  if (clips.some((c) => c.atMs < a && c.atMs + c.lengthMs > b)) return [];
  return clips.filter((c) => {
    const end = c.atMs + c.lengthMs;
    if (c.lengthMs <= 0) return c.atMs > a && c.atMs < b;
    return (c.atMs >= a - 1 && end <= b + 1) || (c.atMs < a && end > a && a - c.atMs < EDGE) || (c.atMs < b && end > b && end - b < EDGE);
  }).map((c) => c.id);
}

/** Of a clip (`n`) whose take was made carrying on from a clip removed (`from`): what is left to do. */
const carriesOn = (n: number, from: number) => `Clip ${n}'s take was made carrying on from clip ${from}: its start no longer matches. Render clip ${n} again for a clean start after the cut.`;

/** A moment of a recording or source, as the warning says it. */
const at = (ms: number) => clock(ms, { decimals: 1 });

/** "Clip 4", "Clips 3 and 4", "Clips 2, 3 and 5". */
function clipsSaid(cs: Clip[], number: (id: string) => number): string {
  const ns = cs.map((c) => number(c.id));
  return ns.length === 1 ? `Clip ${ns[0]}` : `Clips ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}

/**
 * A timeline's runs of clips made of one stretch, in order: the source's windows, then each recording's Lip sync clips; each
 * clip's part in ms of it (`from` where its own frames begin: a window that carries on starts after the frames it carries,
 * as the server reads it).
 */
function runsOf(t: Timeline, recipes: RecipeInfo[]) {
  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe);
  const runs: Array<{ kind: "source" | "recording"; name: string; what: string; clips: Clip[]; span(c: Clip): { from: number; to: number } }> = [];
  const source = t.source;
  const sourceRecipe = recipes.find((r) => r.id === source?.recipe);
  const w = windowed(sourceRecipe);
  const windows = source && w ? madeFromSource(t, recipes) : [];
  if (source && w && windows.length) {
    runs.push({
      kind: "source", name: source.video.name, what: "the source", clips: windows,
      span: (c) => {
        const start = Number(c.inputs[w.start] ?? 0) * 1000;
        const own = c.joined === "continue" && c !== windows[0] ? start + (carriedOf(recipeOf(c) ?? sourceRecipe, c.inputs) * 1000) / w.shape.fps : start;
        return { from: own, to: start + Number(c.inputs[w.seconds] ?? 0) * 1000 };
      },
    });
  }
  const byAsset = new Map<string, Clip[]>();
  for (const c of t.clips) {
    const input = c.kind === "video" ? recordingInput(recipeOf(c)) : null;
    const asset = input ? c.inputs[input.id] : undefined;
    if (typeof asset === "string" && asset) byAsset.set(asset, [...(byAsset.get(asset) ?? []), c]);
  }
  for (const [asset, clips] of byAsset) {
    const input = recordingInput(recipeOf(clips[0]!))!;
    const name = t.recordings?.find((r) => r.asset.id === asset)?.asset.name ?? "the recording";
    runs.push({
      kind: "recording", name, what: "the recording", clips,
      span: (c) => {
        const start = Number(c.inputs[input.start] ?? 0) * 1000;
        return { from: start, to: start + Number(c.inputs[input.seconds] ?? 0) * 1000 };
      },
    });
  }
  return runs;
}
