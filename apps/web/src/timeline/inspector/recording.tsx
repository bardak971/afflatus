import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CUT_WINDOW_MOST, cutOn, type CutOn } from "@afflatus/core";
import { api, type Asset, type Clip } from "../../api";
import { timelineKey } from "../../draftMachine";
import { clock as mmss, plural } from "../../format";
import { RenderOn } from "../../GenerateOn";
import { severalMachines } from "../../machines";
import { useQueue } from "../../data";
import { queryKeys } from "../../queryKeys";
import { Select, type Option } from "../../Select";
import { AutoText, Button, cx, fieldClass, Help, NumberBox, Segmented } from "../../ui";
import { useClock, type Clock } from "../clock";
import { ColumnEdge, FoldButton, useColumnWidth } from "../column";
import type { RecordingPlace } from "../recordingPlace";
import { CloseButton, Slide } from "./parts";

/** A recording open in the column, as the editor hands it over (editorProps' recordingPanelProps). */
export type RecordingPanelProps = {
  timelineId: string;
  recording: Asset;
  place: RecordingPlace;
  /** The form its new clips are made in (a re-cut's parts no clip had, a longer Out's), among the forms under a recording. */
  newClips: { value: string; options: Option[]; onChange(recipe: string): void; pending: boolean };
  /** Each clip's form among those under a recording (card #72), changed in place: its options say how it meets the clip before. */
  forms: { of(clip: Clip): Option[]; change(clip: string, recipe: string): void };
  /** The timeline's clock: the clip under the playhead is lit in the list. */
  clock: Clock;
  onClose(): void;
  /** In and Out typed (ms of the recording): a trim, as its band's edges and I / O on the stage. */
  onUses(fromMs: number, toMs: number): void;
  /** Its start moved, rendered clips in the way: Change or Keep. */
  trimAsk: { fromMs: number; rendered: number; clips: number; change(): void; keep(): void } | null;
  trimming: boolean;
  /** How it is cut into clips: about `seconds` each, ± `within` (0: exactly that); changed, its clips are made anew. */
  cut: {
    seconds: number;
    within: number;
    leastMs: number;
    mostMs: number;
    run(seconds: number, within: number): void;
    ask: { rendered: number; clips: number; change(): void; keep(): void } | null;
    pending: boolean;
  };
  onSelectClip(id: string): void;
  /** How its first clip opens: carrying on from the clip before (its number; null: none before it), or on a picture, a cut. */
  opens: { before: number | null; joined: "continue" | "cut"; onJoined(joined: "continue" | "cut"): void };
  /** The settings its clips can share, each with the value they all have (null: not the same in every clip). */
  shared: Array<{ id: string; label: string; value: string | null; placeholder?: string }>;
  onShared(inputs: Record<string, unknown>): void;
  /** What they share on its way to all of them: the fields keep what was typed until it is in their forms. */
  sharing: boolean;
  /**
   * Its clips with nothing to play sent to render, as the source's panel sends its own; `waiting`: those with nothing to
   * play that cannot render yet, and why (the first one's reason).
   */
  render: { left: number; queued: number; waiting: number; why: string | null; run(): void; rendering: boolean };
};

/**
 * A recording open in the column (its band on the Audio row clicked), as the source lane opens its own panel: the form its
 * new clips are made in, the stretch of it they use (In → Out), how it is cut into them (Clip length ± a window),
 * its clips with their parts, forms and takes (Lip sync, or one it plays over: card #72), how the first one opens, what
 * they share, and Render N clips at the foot. A clip's own Recording chapter stays as it is; the edits here go through
 * the same paths.
 */
export function RecordingPanel(p: RecordingPanelProps) {
  const panelWidth = useColumnWidth();
  const several = severalMachines(useQueue().data).length > 0;
  const { recording, place, cut } = p;
  const first = place.parts[0]!;
  const last = place.parts.at(-1)!;
  const numbers = first.number === last.number ? `clip ${first.number}` : `clips ${first.number}–${last.number}`;
  const usesMs = place.toMs - place.fromMs;
  const leastMs = Math.ceil(cut.leastMs / 100) * 100;
  const mostMs = Math.max(leastMs, Math.floor(cut.mostMs / 100) * 100);
  const lengths = place.parts.map((x) => ((x.endMs - x.startMs) / 1000).toFixed(1));
  const landed = useLanded(recording.id, place, cut.within);
  // how many it plays over (another form than Lip sync), said beside how many follow it with the mouth
  const over = place.parts.filter((x) => x.over).length;
  const forms = over ? ` · ${place.parts.length - over} lip sync, ${over === 1 ? "1 plays over" : `${over} play over`}` : "";

  return (
    <aside data-designer-stays aria-label={`Recording ${recording.name}`} style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
          <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-chip bg-accent-wash px-2 text-xs font-bold text-accent uppercase">Recording</span>
          <span className="truncate font-semibold">{recording.name}</span>
          <span className="text-xs text-ink-3">{(place.lengthMs / 1000).toFixed(1)} s · under {numbers}{forms}</span>
        </div>
        <FoldButton />
        <span className="ml-1.5 flex shrink-0 border-l border-line pl-1.5"><CloseButton onClose={p.onClose} /></span>
      </div>

      <div className="flex min-h-0 grow flex-col overflow-y-auto">
        <Section title="New clips" help="The form a cut, a re-cut or a longer Out makes its new clips in. A clip whose part survives a re-cut keeps its own form, and each clip can take another below. Lip sync: the mouth follows its part. Video with audio (H3, LTX) or Wan: the recording plays over the clip unchanged, the model's own sound dropped. A recording dropped on an LTX clip is cut into LTX Lip sync clips, else H3's.">
          <Select label="New clips" size="sm" value={p.newClips.value} options={p.newClips.options} onChange={p.newClips.onChange} disabled={p.newClips.pending} />
        </Section>

        <Section title="Uses" note="In → Out">
          {p.trimAsk && (
            <Ask
              title={`The recording starting at ${mmss(p.trimAsk.fromMs, { decimals: 1 })} cuts its clips again:`}
              says={`its ${plural(p.trimAsk.clips, "clip")} are made anew; ${plural(p.trimAsk.rendered, "rendered take")} go to the library (Undo brings them back). To keep them, trim its end instead.`}
              change={p.trimAsk.change}
              keep={p.trimAsk.keep}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <NumberBox label="In (s of the recording)" value={place.fromMs / 1000} min={0} max={Math.max(0, place.toMs / 1000 - 1)} step={0.1} unit=" s" onCommit={(v) => p.onUses(Math.round(v * 1000), place.toMs)} />
            <span className="text-ink-3">→</span>
            <NumberBox label="Out (s of the recording)" value={place.toMs / 1000} min={place.fromMs / 1000 + 1} max={place.lengthMs / 1000} step={0.1} unit=" s" onCommit={(v) => p.onUses(place.fromMs, Math.round(v * 1000))} />
            <span className="text-xs text-ink-2">· {(usesMs / 1000).toFixed(1)} s</span>
          </div>
          {p.trimming && <span className="text-xs text-ink-2">Trimming the recording…</span>}
        </Section>

        <Section title="Clips" help={`How the stretch is cut into clips. Each clip ends within ± that many seconds of Clip length, at the best spot there: a pause in the voice (its middle), else the end of a timed lyric line the file carries (Suno's m4a has them), else the quietest moment, a breath between phrases on a song. ± 0: every clip exactly that length, wherever the words are. Always within what one clip of the model takes. Changed, its clips are made anew over the same stretch: each keeps its form where its part survives, new parts take New clips' form.${landed ? ` Here: ${landed}.` : ""}`}>
          {cut.ask && (
            <Ask
              title="Cutting it again makes its clips anew:"
              says={`its ${plural(cut.ask.clips, "clip")} are made anew; ${plural(cut.ask.rendered, "rendered take")} go to the library (Undo brings them back).`}
              change={cut.ask.change}
              keep={cut.ask.keep}
            />
          )}
          <div className="flex items-end gap-2">
            <div className="min-w-0 grow">
              <Slide label="Clip length" value={Math.min(Math.max(cut.seconds * 1000, leastMs), mostMs)} min={leastMs} max={mostMs} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(ms) => cut.run(ms / 1000, cut.within)} disabled={cut.pending} />
            </div>
            <span className="flex shrink-0 items-center gap-1 text-ink-2">
              ±
              <NumberBox label="Window (± s of Clip length)" value={cut.within} min={0} max={CUT_WINDOW_MOST} step={0.1} unit=" s" onCommit={(v) => !cut.pending && v !== cut.within && cut.run(cut.seconds, v)} />
            </span>
          </div>
          <span className="text-xs text-ink-2">{landed ? `${landed} · ` : ""}{lengths.join(", ")} s</span>
          {cut.pending && <span className="text-xs text-ink-2">Cutting the recording again…</span>}
        </Section>

        <Section title="Its clips" note={String(place.parts.length)}>
          <ClipRows place={place} clock={p.clock} forms={p.forms} onSelectClip={p.onSelectClip} />
        </Section>

        <Section title="Opens from" help="How its first clip starts: carrying on from the clip before it (a seamless join), or on its own from a picture, a cut.">
          {p.opens.before === null ? (
            <span className="text-xs text-ink-2">It opens the timeline: clip {first.number} starts from its own first frame (a picture in its form) or from nothing.</span>
          ) : (
            <Segmented<"continue" | "cut">
              label="Opens from"
              size="sm"
              value={p.opens.joined}
              onChange={p.opens.onJoined}
              options={[{ value: "continue", label: `Clip ${p.opens.before} · seamless` }, { value: "cut", label: "A picture · a cut" }]}
            />
          )}
          {p.opens.joined === "cut" && p.opens.before !== null && (
            <span className="text-xs text-ink-2">
              The picture is clip {first.number}'s first frame: <button type="button" className="underline" onClick={() => p.onSelectClip(first.clip.id)}>open clip {first.number}</button> to set it.
            </span>
          )}
        </Section>

        {p.shared.length > 0 && (
          <Section title="Shared by its clips" help="What every clip of the recording is made with. Typed here, it goes to all of them at once (one step to undo); a clip changed on its own keeps it until this is typed again.">
            {p.shared.map((f) => (
              <SharedField key={f.id} field={f} count={place.parts.length} sharing={p.sharing} onCommit={(value) => p.onShared({ [f.id]: value || null })} />
            ))}
          </Section>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3.5 py-3">
        {p.render.why && <span className="text-xs text-warn-ink">{p.render.why}</span>}
        <span className="flex">
          <Button tone="primary" className={cx("h-11 grow text-sm", several && p.render.left > 0 && "rounded-r-none!")} disabled={p.render.rendering || p.render.left === 0} onClick={p.render.run}>
            {p.render.rendering ? "Sending…" : p.render.left > 0 ? `Render ${plural(p.render.left, "clip")}` : p.render.queued > 0 ? `Rendering · ${p.render.queued} in the queue` : p.render.waiting > 0 ? `Render ${plural(p.render.waiting, "clip")}` : "Every clip rendered"}
          </Button>
          {p.render.left > 0 && <RenderOn pickKey={timelineKey(p.timelineId)} msOn={() => null} />}
        </span>
      </div>
    </aside>
  );
}

/** What each kind of cut is said as, in the order the cut looks for them. */
const LANDED: Array<[CutOn, string]> = [["pause", "on a pause"], ["line", "on a lyric line"], ["quiet", "on the quietest moment"], ["length", "at the length"]];

/**
 * What its clips' ends were cut at (cutOn), counted: "3 on a pause, 20 on a lyric line, 7 on the quietest moment". The last
 * clip ends at the Out, at none of them. Null while the recording's pauses and lines are read, or with a single clip.
 */
function useLanded(asset: string, place: RecordingPlace, within: number): string | null {
  const marks = useQuery({ queryKey: queryKeys.pauses(asset), queryFn: () => api.pauses(asset), staleTime: Infinity, retry: 0 });
  if (!marks.data || place.parts.length < 2) return null;
  const on = place.parts.slice(0, -1).map((x) => cutOn(x.endMs / 1000, marks.data, within));
  return LANDED.map(([kind, said]) => [on.filter((k) => k === kind).length, said] as const).filter(([n]) => n > 0).map(([n, said], i) => `${i === 0 ? plural(n, "clip") : n} ${said}`).join(", ");
}

function Section({ title, note, help, children }: { title: string; note?: string; help?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5 border-b border-line px-4 py-3">
      <h4 className="flex items-center justify-between text-meta font-semibold tracking-wide text-ink-3 uppercase">
        {title}
        {note && <span className="font-normal tracking-normal normal-case">{note}</span>}
        {help && <Help text={help} title={title} />}
      </h4>
      {children}
    </section>
  );
}

/** A change that leaves rendered takes behind, asked first: Change or Keep it. */
function Ask({ title, says, change, keep }: { title: string; says: string; change(): void; keep(): void }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-warn-wash/40 p-2.5">
      <span className="text-xs"><span className="font-semibold">{title}</span> <span className="text-ink-2">{says}</span></span>
      <span className="flex gap-1.5">
        <Button size="sm" tone="primary" onClick={change}>Change</Button>
        <Button size="sm" onClick={keep}>Keep it</Button>
      </span>
    </div>
  );
}

/** What a clip shows in the list: in the queue, rendering, its take playing, or empty. */
function stateOf(c: Clip): { said: string; good: boolean } {
  if (c.job) return { said: c.job.status === "running" ? "rendering" : "in the queue", good: false };
  if (c.take) return { said: `take ${c.takes.findIndex((x) => x.id === c.take!.id) + 1}`, good: true };
  return { said: "empty", good: false };
}

/**
 * Its clips, each with its part of the recording, its form (changed in place: Lip sync, or one the recording plays over)
 * and whether it has a take; the one under the playhead lit. Reads the clock on its own: only the list redraws as the
 * recording plays. A click on its number or part opens that clip.
 */
function ClipRows({ place, clock, forms, onSelectClip }: { place: RecordingPlace; clock: Clock; forms: RecordingPanelProps["forms"]; onSelectClip(id: string): void }) {
  const now = useClock(clock);
  const under = place.parts.find((x) => now >= x.clipFromMs && now < x.clipToMs);
  return (
    <div className="flex flex-col">
      {place.parts.map((x) => {
        const s = stateOf(x.clip);
        const here = x === under;
        return (
          <div key={x.clip.id} data-plays-over={x.over || undefined} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 border-t border-line py-1 text-sm first:border-t-0">
            <button
              type="button"
              aria-current={here || undefined}
              aria-label={`Clip ${x.number}, ${mmss(x.startMs, { decimals: 1 })}–${mmss(x.endMs, { decimals: 1 })}, ${s.said}`}
              onClick={() => onSelectClip(x.clip.id)}
              className="grid grid-cols-[3.25rem_1fr] items-baseline gap-x-1.5 rounded py-0.5 text-left hover:bg-hover"
            >
              <span className={cx("font-semibold", here ? "text-accent" : "text-ink-strong")}>Clip {x.number}</span>
              <span className={cx("font-mono text-xs whitespace-nowrap", here ? "text-accent" : "text-ink-2")}>{mmss(x.startMs, { decimals: 1 })}–{mmss(x.endMs, { decimals: 1 })}</span>
            </button>
            <Select label={`Clip ${x.number}'s form`} size="sm" value={x.clip.recipe ?? ""} options={forms.of(x.clip)} onChange={(to) => to !== x.clip.recipe && forms.change(x.clip.id, to)} disabled={Boolean(x.clip.job)} />
            <span className={cx("text-right text-xs", s.good ? "text-good" : "text-ink-3")}>{s.said}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One setting the clips share: typed here, given to all of them when it is left (blur), if it changed. */
function SharedField({ field, count, sharing, onCommit }: { field: RecordingPanelProps["shared"][number]; count: number; sharing: boolean; onCommit(value: string): void }) {
  const [text, setText] = useState<string | null>(null);
  // given to all: what was typed stays shown until it is in their forms, never the old text a moment. Only the text last
  // sent is let go, once every share is back and the clips carry it: typed again meanwhile, the newer text stays (its own
  // blur shares it); a share that failed leaves it shown, as typed, for the next blur to send again
  const [sent, setSent] = useState<string | null>(null);
  const value = field.value ?? "";
  useEffect(() => {
    if (sharing || sent === null) return;
    if (text !== sent) return setSent(null);
    if (value !== sent) return;
    setSent(null);
    setText(null);
  }, [sharing, sent, text, value]);
  const shown = text ?? field.value ?? "";
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-ink-2">{field.label}</span>
      <AutoText
        value={shown}
        aria-label={field.label}
        placeholder={field.value === null ? `Each clip has its own: typed here, it goes to all ${count}` : field.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null && text !== (field.value ?? "")) {
            onCommit(text);
            setSent(text);
          } else setText(null);
        }}
        className={fieldClass}
      />
    </label>
  );
}
