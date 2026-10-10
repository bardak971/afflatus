import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, type Clip, type Timeline } from "../../api";
import type { Clock } from "../clock";
import type { Slot } from "../model";
import { motionOf } from "../measures";
import { queryKeys } from "../../queryKeys";

/** How much moves along a video and how loud it is, as the server measures it. */
export type Motion = Awaited<ReturnType<typeof api.motion>>;
/** The measurements as one array that only changes when one of them does: the motion smoothing below is keyed on it, not on every render. */
const measuresData = (results: Array<{ data: Motion | undefined }>) => results.map((r) => r.data);

/**
 * How much moves along each clip's take and how loud it is, measured once and kept: the sound drawn behind
 * each row, the quiet moments and pauses In and Out snap to, and the snap itself.
 */
export function useMotionMarks({ slots, clips, timeline, playEnd, pps, clock, snapQuiet }: {
  slots: Slot[];
  clips: Clip[];
  timeline: Timeline;
  /** Where what plays ends. */
  playEnd: number;
  pps: number;
  /** The moment of what plays: In and Out snap to the playhead too, read as they are moved. */
  clock: Clock;
  snapQuiet?: boolean;
}) {

  // how much moves along each clip's take and how loud it is (and the sound files, and the music): measured once, kept
  const played = useMemo(() => slots.filter((s) => !s.planned && s.clip.take), [slots]);
  const measured = useMemo(() => {
    const ids = new Set<string>();
    for (const s of played) ids.add(s.clip.take!.asset.id);
    for (const c of clips) if (c.sound === "file" && c.soundAsset) ids.add(c.soundAsset.id);
    if (timeline.music) ids.add(timeline.music.asset.id);
    return [...ids];
  }, [played, clips, timeline.music]);
  const measures = useQueries({
    // the same queries as one video's (queryKeys.motion(id)), asked for together: one request for the timeline, not one per take
    queries: measured.map((id) => ({ queryKey: queryKeys.motion(id), queryFn: () => motionOf(id), staleTime: Infinity, retry: 0 })),
    combine: measuresData,
  });
  const measureOf = (id: string | undefined) => (id ? measures[measured.indexOf(id)] : undefined);
  /** The motion of what plays, per clip: samples along the clip's playing part, each 0..1 of the clip's own peak; its quiet moments and its pauses in the sound, on the clock of what plays. */
  const motion = useMemo(() => {
    return played.map((s) => {
      const m = measureOf(s.clip.take!.asset.id);
      const take = s.clip.take!;
      if (!m) return { slot: s, curve: [] as number[], quiet: [] as number[], pauses: [] as number[] };
      const step = 1000 / m.rate;
      const from = Math.floor(take.startMs / step);
      const quiet: number[] = [];
      let curve: number[] = [];
      if (m.values.length) {
        const to = Math.min(m.values.length - 1, Math.ceil(take.endMs / step));
        const raw = m.values.slice(from, to + 1);
        // smoothed over three samples, so that one odd frame is not a dip
        const smooth = raw.map((_v, k) => ((raw[k - 1] ?? raw[k]!) + raw[k]! + (raw[k + 1] ?? raw[k]!)) / 3);
        const peak = Math.max(1, ...smooth);
        const sorted = [...smooth].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        for (let k = 1; k < smooth.length - 1; k++) {
          if (smooth[k]! <= smooth[k - 1]! && smooth[k]! < smooth[k + 1]! && smooth[k]! < median * 0.8) {
            const assetMs = (from + k) * step;
            if (assetMs > take.startMs + 100 && assetMs < take.endMs - 100) quiet.push(s.clip.atMs + (assetMs - take.startMs));
          }
        }
        curve = smooth.map((v) => v / peak);
      }
      // pauses: stretches of at least a quarter second well under the loud parts, between sounds (not the clip's silent ends)
      const pauses: number[] = [];
      if (m.sound && m.sound.length && s.clip.sound === "own") {
        const to = Math.min(m.sound.length - 1, Math.ceil(take.endMs / step));
        const db = m.sound.slice(from, to + 1);
        const loud = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.9)] ?? 0;
        const threshold = Math.min(loud - 20, -25);
        let run = -1;
        for (let k = 0; k <= db.length; k++) {
          const low = k < db.length && db[k]! < threshold;
          if (low && run < 0) run = k;
          if (!low && run >= 0) {
            if (k - run >= 3 && run > 0 && k < db.length) pauses.push(s.clip.atMs + ((from + (run + k) / 2) * step - take.startMs));
            run = -1;
          }
        }
      }
      return { slot: s, curve, quiet, pauses };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measures is the read measureOf looks into, listed instead
  }, [played, measures]);
  const snapRange = (ms: number) => {
    const marks = [...slots.filter((s) => !s.planned).flatMap((s) => [s.clip.atMs, s.clip.atMs + s.clip.lengthMs]), clock.get()];
    let best = ms;
    let gap = 7 / pps * 1000;
    for (const m of marks) {
      const d = Math.abs(m - ms);
      if (d < gap) {
        gap = d;
        best = m;
      }
    }
    // a quiet moment or a pause in the sound within a third of a second wins over nothing, not over a cut or the playhead at hand
    if (snapQuiet !== false && best === ms) {
      let near = 334;
      for (const q of motion.flatMap((m) => [...m.quiet, ...m.pauses])) {
        const d = Math.abs(q - ms);
        if (d < near) {
          near = d;
          best = q;
        }
      }
    }
    return Math.max(0, Math.min(playEnd, best));
  };

  return { measureOf, motion, snapRange };
}
