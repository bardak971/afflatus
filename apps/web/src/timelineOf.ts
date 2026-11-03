/**
 * Items put on a timeline, the one way every place does it (the viewer, a tile's menu, the library's header, the
 * Projects panel, a drop on New timeline, a drop on the tray's Add to timeline): at the end of `into`, or of a new
 * timeline in the project the rail looks at, in the order given. A video is a clip, a picture a still (the server's
 * default for a picture), a sound the timeline's music (the video track takes no sound).
 */
export interface TimelineOf {
  assets: ReadonlyArray<{ id: string; kind?: string; name?: string }>;
  /** The timeline they go to; left out or null, a new one. */
  into?: { id: string; name: string } | null;
  /** A picture first is the first frame of a clip 1 to render (a timeline started from it), not a still. */
  firstAsClip?: boolean;
  /**
   * Each item on its own: one the server refuses is handed here and the others still go (a drop of several files says
   * "8 of 10 added"). Left out, the first refusal stops the rest and fails the whole.
   */
  refused?(asset: { id: string; kind?: string; name?: string }, err: Error): void;
}

/** What each item is added as, in order: the body of its `addClip`, or a sound the timeline's music. */
export const clipsOf = (v: TimelineOf): Array<{ asset: string; as?: "clip" } | { music: string }> =>
  v.assets.map((a, i) => (a.kind === "audio" ? { music: a.id } : { asset: a.id, ...(v.firstAsClip && i === 0 && a.kind === "image" ? { as: "clip" as const } : {}) }));

/** The timeline made or filled; the calls are handed in so that it can be tested. */
export async function timelineOf(
  v: TimelineOf,
  calls: {
    create(): Promise<{ id: string; name: string }>;
    add(timeline: string, body: { asset: string; as?: "clip" }): Promise<unknown>;
    music(timeline: string, asset: string): Promise<unknown>;
  },
): Promise<{ id: string; name: string }> {
  let t = v.into;
  if (!t) {
    const made = await calls.create();
    t = { id: made.id, name: made.name };
  }
  const bodies = clipsOf(v);
  for (const [i, body] of bodies.entries()) {
    try {
      if ("music" in body) await calls.music(t.id, body.music);
      else await calls.add(t.id, body);
    } catch (err) {
      if (!v.refused) throw err;
      v.refused(v.assets[i]!, err as Error);
    }
  }
  return t;
}
