import type { LeadPart } from "../../RecipeForm";
import { clock as mmss, plural } from "../../format";
import { Button, NumberBox } from "../../ui";

/**
 * A clip under a recording dropped on the track (the rethink's step 6), whatever its form, as its panel shows it: the
 * recording's stretch its clips are made of, In and Out (seconds of the recording), trimmed as a source's is
 * (Timelines.trimRecording), and the question when a moved start would leave rendered takes behind.
 */
export type ClipRecording = {
  /** How many clips the recording made, this one among them; this one's part. */
  count: number;
  /** The recording plays over this clip (a form other than Lip sync, card #72): its mouth does not follow it. */
  over: boolean;
  part: { startMs: number; seconds: number };
  fromMs: number;
  toMs: number;
  onUses(fromMs: number, toMs: number): void;
  /** Its start moved, rendered clips in the way: Change or Keep. */
  ask: { fromMs: number; rendered: number; clips: number; change(): void; keep(): void } | null;
  trimming: boolean;
};

/** The Recording chapter of a clip under a recording: Lip sync's, made around its part, or one the recording plays over. */
export function recordingLead(r: ClipRecording): LeadPart {
  const stretch = `${mmss(r.fromMs, { decimals: 1 })}–${mmss(r.toMs, { decimals: 1 })}`;
  return {
    id: "recording",
    title: "Recording",
    help: r.over
      ? "The clip stays one of the recording's: its part, its place in the recording's list, the join and the song's hand-over stay. What the person does comes from What happens. In and Out set the stretch the recording's clips are made of, as on a Lip sync clip."
      : "The recording this clip is a part of, cut at its pauses into clips. In and Out set the stretch they are made of: the end in drops the clips past it (a rendered one is never shortened), the end out adds clips at its pauses, the start moved makes them anew.",
    summary: `${stretch} · ${plural(r.count, "clip")}${r.over ? " · plays over" : ""}`,
    node: (
      <div className="flex flex-col gap-3">
        {r.over && (
          <span className="text-xs text-ink-2">
            <span className="font-semibold text-ink">Plays over this clip</span>, unchanged: the take keeps the recording's part as its sound, and the model's own sound is dropped. Back to Lip sync, the mouth follows it again.
          </span>
        )}
        <span className="text-xs text-ink-2">
          {stretch} made into {plural(r.count, "clip")} · this one {mmss(r.part.startMs, { decimals: 1 })}–{mmss(r.part.startMs + r.part.seconds * 1000, { decimals: 1 })}
        </span>
        {r.ask && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-warn-wash/40 p-2.5">
            <span className="text-xs">
              <span className="font-semibold">The recording starting at {mmss(r.ask.fromMs, { decimals: 1 })} cuts its clips again:</span>{" "}
              <span className="text-ink-2">its {plural(r.ask.clips, "clip")} are made anew; {plural(r.ask.rendered, "rendered take")} go to the library (Undo brings them back). To keep them, trim its end instead.</span>
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" tone="primary" onClick={r.ask.change}>Change</Button>
              <Button size="sm" onClick={r.ask.keep}>Keep it</Button>
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="grow text-xs font-semibold">Uses</span>
          <NumberBox label="In (s of the recording)" value={r.fromMs / 1000} min={0} max={Math.max(0, r.toMs / 1000 - 1)} step={0.1} unit=" s" onCommit={(v) => r.onUses(Math.round(v * 1000), r.toMs)} />
          <span className="text-ink-3">→</span>
          <NumberBox label="Out (s of the recording)" value={r.toMs / 1000} min={r.fromMs / 1000 + 1} max={3600} step={0.1} unit=" s" onCommit={(v) => r.onUses(r.fromMs, Math.round(v * 1000))} />
        </div>
        {r.trimming && <span className="text-xs text-ink-2">Trimming the recording…</span>}
      </div>
    ),
  };
}
