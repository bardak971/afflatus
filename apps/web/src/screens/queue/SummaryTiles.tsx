import type { TimesSummary } from "../../api";
import { long } from "../../format";
import { cx } from "../../ui";

const maybe = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : long(ms));
export const pct = (share: number) => `${Math.round(share * 100)} %`;

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] border border-line bg-panel px-3.5 py-3">
      <span className="truncate text-xs text-ink-2">{label}</span>
      <span className={cx("truncate font-mono text-[19px] leading-tight", warn && "text-warn-ink")}>{value}</span>
      {note && <span className="text-xs leading-snug text-ink-3">{note}</span>}
    </div>
  );
}

/** The window's totals, one figure a tile. */
export function SummaryTiles({ d }: { d: TimesSummary }) {
  const t = d.tiles;
  return (
    <div className="grid grid-cols-4 gap-2.5 xl:grid-cols-6">
      <Tile label="Renders" value={String(t.done)} note={`${t.images} image${t.images === 1 ? "" : "s"} · ${t.videos} video${t.videos === 1 ? "" : "s"}${t.tools ? ` · ${t.tools} finish${t.tools === 1 ? "" : "es"} or slow motion${t.tools === 1 ? "" : "s"}` : ""}`} />
      <Tile label="Video generated" value={long(t.videoMs)} note="total duration of all clips" />
      <Tile label="Failed · cancelled" value={`${t.failed} · ${t.cancelled}`} note={`${long(t.lostMs)} of GPU time lost`} warn={t.failed > 0} />
      <Tile label="GPU time" value={long(t.gpuMs)} note={`longest render: ${long(t.longestMs)}`} />
      <Tile label="GPU busy" value={pct(t.gpuMs / Math.max(1, d.spanMs))} note="of the period, with Afflatus's renders" />
      <Tile label="Queue wait" value={maybe(t.waitedUsualMs)} note={`median · p90: ${maybe(t.waitedSlowMs)}`} />
      <Tile label="Model load" value={pct(t.loadMs / Math.max(1, t.gpuMs))} note={`${long(t.loadMs)} of the GPU time`} />
      <Tile label="Model loads" value={`${t.loads} time${t.loads === 1 ? "" : "s"}`} note={t.loadUsualMs === null ? undefined : `${long(t.loadUsualMs)} each, median`} />
      <Tile label="Estimate error" value={t.off === null ? "—" : `± ${pct(t.off)}`} note="how far off the estimates usually are" />
      <Tile label="Most used" value={d.models[0]?.name.split(" · ")[0] ?? "—"} note={d.models[0] ? `${pct(d.models[0].gpuMs / Math.max(1, t.gpuMs))} of the GPU time` : undefined} />
      <Tile label="Peak VRAM" value={t.vramPeak === null ? "—" : `${Math.round(t.vramPeak)} %`} note={t.vramUsual === null ? "not reported" : `median ${Math.round(t.vramUsual)} %`} />
      <Tile label="Ran out of VRAM" value={`${t.spills ?? 0} job${t.spills === 1 ? "" : "s"}`} note={t.spills ? `${long(t.spillLostMs ?? 0)} more than expected: their bars are in the warning colour` : "memory full and twice the usual time: none"} warn={(t.spills ?? 0) > 0} />
      {/* 80 °C: a temperature, the same for every card, not a figure of one card */}
      <Tile label="Peak GPU temp" value={t.heatPeak === null ? "—" : `${Math.round(t.heatPeak)}°`} note={t.heatUsual === null ? "not reported" : `median ${Math.round(t.heatUsual)}°`} warn={(t.heatPeak ?? 0) >= 80} />
    </div>
  );
}
