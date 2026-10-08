import type { Clip, ClipPatch } from "../api";

/**
 * What the timeline's Needs attention card lists, each row with the one action that mends it, and Fix all: every
 * row's action at once. Read by the Overview; kept apart so that all of it is tested without a browser.
 */

/** Past ×3 a join shows: its figure as it plays, or the run-up's end (the model stepped away from its guide). */
export const SHOWS = 3;

/** How each take of a clip meets the clip before (`in`) and after (`out`), as the server measures it. */
export type JoinFigures = Array<{ take: string; in: number | null; out: number | null }>;

/** A row's action: render clips, make another take play, or fill the frame. */
export type Act =
  | { do: "render"; clips: string[]; ms: number }
  | { do: "take"; clip: string; take: string; number: number; figure: number }
  | { do: "fill"; clips: string[] };

export interface Row {
  key: string;
  kind: "missing" | "stale" | "failed" | "join" | "shape";
  ids: string[];
  warn: boolean;
  /** A join row's figure: the worse of the join and the run-up's end. */
  figure?: number;
  /** A failed row's reasons, one per clip. */
  reasons?: Array<{ clip: string; why: string }>;
  act?: Act;
}

/** Every row's action as one run: the patches first (a take made to play, the frame filled), then one render of each clip left. */
export interface Fix {
  patches: Array<{ clip: string; patch: ClipPatch }>;
  render: string[];
  ms: number;
}

export function attention(clips: Clip[], o: {
  /** Every take's join figures, per clip that flows on and has a take; undefined while measuring. */
  joins: Map<string, JoinFigures | undefined>;
  /** A video clip with its form filled, not already in the queue. */
  renderable(c: Clip): boolean;
  msOf(c: Clip): number | null;
  /** Of another shape than the video, shown with bars. */
  misfit(c: Clip): boolean;
}): Row[] {
  const render = (list: Clip[]): Act | undefined => {
    const can = list.filter(o.renderable);
    return can.length ? { do: "render", clips: can.map((c) => c.id), ms: can.reduce((sum, c) => sum + (o.msOf(c) ?? 0), 0) } : undefined;
  };
  const rows: Row[] = [];
  // a failed clip is listed once, as failed: Retry is its action; one with its form still to fill is listed, not rendered
  const unrendered = clips.filter((c) => c.kind === "video" && !c.take && !c.job && !c.failed);
  if (unrendered.length) rows.push({ key: "missing", kind: "missing", ids: unrendered.map((c) => c.id), warn: false, act: render(unrendered) });
  const stale = clips.filter((c) => c.join === "stale");
  if (stale.length) rows.push({ key: "stale", kind: "stale", ids: stale.map((c) => c.id), warn: true, act: render(stale) });
  const failed = clips.filter((c) => c.failed && !c.take);
  if (failed.length) rows.push({ key: "failed", kind: "failed", ids: failed.map((c) => c.id), warn: true, reasons: failed.map((c) => ({ clip: c.id, why: c.failed! })), act: render(failed) });
  clips.forEach((c, i) => {
    if (i === 0 || c.joined !== "continue" || !c.take || c.join === "stale") return;
    const items = o.joins.get(c.id);
    const figure = items?.find((j) => j.take === c.take!.id)?.in ?? null;
    const carry = c.take.measure?.handover ?? null;
    const worst = Math.max(figure ?? 0, carry ?? 0);
    if (worst <= SHOWS) return;
    // another take that comes in under ×3 (its run-up's end too), the smoothest of them; measuring still: no action yet
    let better: Extract<Act, { do: "take" }> | null = null;
    for (const [k, t] of c.takes.entries()) {
      const v = items?.find((j) => j.take === t.id)?.in ?? null;
      if (t.id !== c.take.id && v !== null && v <= SHOWS && (t.measure?.handover ?? 0) <= SHOWS && (!better || v < better.figure)) better = { do: "take", clip: c.id, take: t.id, number: k + 1, figure: v };
    }
    const act = !items ? undefined : better ?? render([c]);
    rows.push({ key: `join:${c.id}`, kind: "join", ids: [c.id], warn: true, figure: worst, act });
  });
  const wrong = clips.filter(o.misfit);
  if (wrong.length) rows.push({ key: "shape", kind: "shape", ids: wrong.map((c) => c.id), warn: false, act: { do: "fill", clips: wrong.map((c) => c.id) } });
  return rows;
}

/** Fix all, once two rows or more have an action: each clip rendered once, in timeline order, after the patches. */
export function fixAll(rows: Row[], clips: Clip[], msOf: (c: Clip) => number | null): Fix | null {
  const acts = rows.flatMap((r) => (r.act ? [r.act] : []));
  if (acts.length < 2) return null;
  const patches: Fix["patches"] = [];
  const wanted = new Set<string>();
  for (const a of acts) {
    if (a.do === "take") patches.push({ clip: a.clip, patch: { take: a.take } });
    else if (a.do === "fill") for (const clip of a.clips) patches.push({ clip, patch: { fill: true } });
    else for (const clip of a.clips) wanted.add(clip);
  }
  const render = clips.filter((c) => wanted.has(c.id));
  return { patches, render: render.map((c) => c.id), ms: render.reduce((sum, c) => sum + (msOf(c) ?? 0), 0) };
}

/**
 * A row set aside ("keep as it is": the smoother take was not the better one, the clip is not in the cut): what it is
 * and the take each of its clips plays. Another take, or a new render, is another decision: the row comes back.
 * A clip with nothing rendered is never set aside: there is nothing to keep.
 */
export const canDismiss = (r: Row) => r.kind !== "missing";
export const dismissKey = (r: Row, clips: Clip[]) => `${r.kind}:${r.ids.map((id) => `${id}@${clips.find((c) => c.id === id)?.take?.id ?? "-"}`).join(",")}`;
