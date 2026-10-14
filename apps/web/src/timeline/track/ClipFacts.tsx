import { useQuery } from "@tanstack/react-query";
import { api, type Clip } from "../../api";
import { cx } from "../../ui";
import { past, pct, type Against } from "../lookDrift";
import { clipFacts, PEEK } from "./peek";
import { queryKeys } from "../../queryKeys";

/** The rows of the drift table: what each says, and how it is read. */
const ROWS: Array<{ key: Exclude<keyof Against, "colour">; label: string }> = [
  { key: "luma", label: "Brightness" },
  { key: "sharp", label: "Sharpness" },
  { key: "grain", label: "Grain" },
  { key: "face", label: "Face" },
  { key: "pace", label: "Pace" },
];

/**
 * The clip's figures, on the right of the frame card while the pointer is on a clip (see clipFacts): what used
 * to wait a second under the clip, now beside its frame at once:
 * a take's figures, or a few words for a still or a clip with no take.
 */
export function ClipFacts({ clip, index, clips }: { clip: Clip; index: number; clips: Clip[] }) {
  const take = clip.kind === "video" ? clip.take : null;
  // how much the picture jumps where this clip meets the one before: measured once the takes are there
  const joins = useQuery({
    queryKey: queryKeys.joins.around(clip, clips[index - 1], clips[index + 1]),
    queryFn: () => api.joins(clip.id),
    enabled: Boolean(take) && index > 0 && clip.joined === "continue",
    staleTime: 60_000,
  });
  const jump = joins.data?.items.find((j) => j.take === take?.id)?.in ?? null;
  const f = clipFacts(clip, index, clips, jump);
  const d = f.drift;
  const all = d ? (d.same ? [{ head: `vs clip ${d.start + 1} (the one before)`, of: d.whole }] : [{ head: `vs clip ${d.before + 1}`, of: d.hop }, { head: `vs clip ${d.start + 1}`, of: d.whole }]) : [];

  // takes rendered before the measure existed: no figures to set against, said once instead of a table of dashes
  const blank = all.length > 0 && all.every((c) => ROWS.every((r) => c.of[r.key] == null));
  const cols = blank ? [] : all;
  return (
    <div className="flex shrink-0 flex-col gap-2.5 self-stretch border-l border-line py-1.5 pr-1.5 pl-3.5 text-[13px]" style={{ width: f.head ? PEEK.facts : PEEK.factsShort }}>
      {f.head && (
        <span className="flex flex-wrap items-baseline gap-1.5">
          <b className="font-mono font-semibold text-ink">{f.head.text}</b>
          {f.head.detail && <span className="text-ink-3">· {f.head.detail}</span>}
        </span>
      )}
      {f.chips.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {f.chips.map((c) => (
            <span key={c.text} className={cx("rounded-md px-[7px] py-px text-[11px] font-bold", c.tone === "accent" ? "bg-accent-wash text-accent" : "bg-hover text-ink-2")}>{c.text}</span>
          ))}
        </span>
      )}
      {blank && <span className="text-xs text-ink-3">No figures against clip {d!.before + 1}: its take was not measured</span>}
      {cols.length > 0 && (
        <div className="grid gap-x-3.5 text-xs" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
          <span className="border-b border-line pb-1" />
          {cols.map((c) => <span key={c.head} className="truncate border-b border-line pb-1 text-right text-[11px] font-semibold text-ink-3">{c.head}</span>)}
          {ROWS.map((r) => (
            <span key={r.key} className="contents">
              <span className="py-[3px] text-ink">{r.label}</span>
              {cols.map((c) => {
                const x = c.of[r.key];
                return <span key={c.head} className={cx("py-[3px] text-right font-mono tabular-nums", x == null ? "text-ink-3" : past(r.key, x) ? "text-warn" : "text-ink-2")}>{x == null ? "—" : pct(x)}</span>;
              })}
            </span>
          ))}
        </div>
      )}
      {f.lines.map((l) => (
        <span key={l.text} className={cx(l.tone === "warn" ? "text-warn-ink" : l.tone === "dim" ? "text-ink-2" : l.tone === "accent" ? "text-accent" : "font-semibold text-ink")}>{l.text}</span>
      ))}
      {f.foot.length > 0 && (
        <span className="mt-auto text-[11.5px] text-ink-3">
          {f.foot.map((l, i) => (
            <span key={l.text}>{i > 0 && " · "}<span className={cx(l.tone === "accent" && "text-accent")}>{l.text}</span></span>
          ))}
        </span>
      )}
    </div>
  );
}
