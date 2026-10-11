/**
 * Items put on a timeline, the one way every place does it (the viewer, a tile's menu, the library's header, the
 * Projects panel, a drop on New timeline): at the end of `into`, or of a new timeline in the project the rail looks
 * at, in the order given.
 */
export interface TimelineOf {
  assets: ReadonlyArray<{ id: string; kind?: string }>;
  /** The timeline they go to; left out or null, a new one. */
  into?: { id: string; name: string } | null;
  /** A picture first is the first frame of a clip 1 to render (a timeline started from it), not a still. */
  firstAsClip?: boolean;
}

/** What each item is added as, in order: the body of its `addClip`. */
export const clipsOf = (v: TimelineOf): Array<{ asset: string; as?: "clip" }> =>
  v.assets.map((a, i) => ({ asset: a.id, ...(v.firstAsClip && i === 0 && a.kind === "image" ? { as: "clip" as const } : {}) }));

/** The timeline made or filled; the calls are handed in so that it can be tested. */
export async function timelineOf(
  v: TimelineOf,
  calls: { create(): Promise<{ id: string; name: string }>; add(timeline: string, body: { asset: string; as?: "clip" }): Promise<unknown> },
): Promise<{ id: string; name: string }> {
  let t = v.into;
  if (!t) {
    const made = await calls.create();
    t = { id: made.id, name: made.name };
  }
  for (const body of clipsOf(v)) await calls.add(t.id, body);
  return t;
}
