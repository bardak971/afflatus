import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronRight, Copy, Eraser, Pause, Play, Search, X } from "lucide-react";
import { api } from "../../api";
import { useQueue } from "../../data";
import { logRows, type LogLine, type LogRow } from "./logRows";
import { copyText } from "../../secureContext";
import { Button, cx, ErrorNote } from "../../ui";

/**
 * ComfyUI's terminal, live: its last few hundred lines are read every two seconds and kept here as
 * they scroll by (up to a few thousand), so that what a render printed is still there after the
 * next one. Errors and warnings are coloured, a prompt's start and end marked and named after its job (a click
 * shows only its lines), a progress bar folded into its latest, a traceback into its last line. The view follows
 * the end until it is scrolled up.
 */

type Line = LogLine;
const KEEP = 4000;
/** The rows drawn at once, from the end; more on asking. Thousands of rows redrawn on each read made the tab crawl. */
const DRAWN = 400;

const toneOf = (m: string): Line["tone"] =>
  /\[ERROR\]|Traceback|Error:|error\b.*\bexecuting|CUDA out of memory|not enough memory/i.test(m) ? "error"
  : /\[WARN|warning/i.test(m) ? "warn"
  : /got prompt|Prompt executed in|Requested to load|Loaded completely|loaded completely/i.test(m) ? "mark"
  : "plain";
const clock = (t: string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t.slice(11, 19) : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

export function ComfyLog({ online }: { online: boolean }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [onlyTrouble, setOnlyTrouble] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [stuck, setStuck] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const log = useQuery({ queryKey: ["comfy-log"], queryFn: api.comfyLogs, refetchInterval: paused ? false : 2000, enabled: online, retry: 0 });
  // the jobs a prompt may have run for: the one running and the recent ones
  const queue = useQueue();
  const listed = [...(queue.data?.running ? [queue.data.running] : []), ...(queue.data?.recent ?? [])];
  // read again only when the jobs themselves change: a progress event (several a second) changes the queue, not these
  const jobsKey = listed.map((j) => `${j.id}|${j.startedAt ?? ""}|${j.label}`).join(",");
  const jobs = useMemo(() => listed.map((j) => ({ id: j.id, label: j.label, startedAt: j.startedAt })), [jobsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [onlyJob, setOnlyJob] = useState<{ id: string; label: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drawn, setDrawn] = useState(DRAWN);

  // what came in since last time goes on the end; ComfyUI keeps a window, this keeps the scroll
  useEffect(() => {
    if (!log.data) return;
    const fresh: Line[] = [];
    for (const e of log.data.lines) {
      const key = `${e.t}\u0000${e.m}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh.push({ key, t: e.t, m: e.m, tone: toneOf(e.m) });
    }
    if (!fresh.length) return;
    setLines((all) => {
      const next = [...all, ...fresh];
      if (next.length > KEEP) {
        for (const gone of next.splice(0, next.length - KEEP)) seen.current.delete(gone.key);
      }
      return next;
    });
  }, [log.data]);
  // the end stays in view until the reader scrolls up
  useEffect(() => {
    if (stuck && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, stuck, filter, onlyTrouble]);

  const rows = useMemo(() => logRows(lines, jobs), [lines, jobs]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const textOf = (r: LogRow) => (r.kind === "trace" ? r.lines.map((l) => l.m).join("\n") : r.line.m);
    const trouble = (r: LogRow) => r.kind === "trace" || (r.kind !== "start" && (r.line.tone === "error" || r.line.tone === "warn"));
    return rows.filter((r) => (!onlyJob || r.job === onlyJob.id) && (!onlyTrouble || trouble(r)) && (!q || textOf(r).toLowerCase().includes(q)));
  }, [rows, filter, onlyTrouble, onlyJob]);
  // every line of what is shown, for Copy: a folded bar as its latest, a traceback whole
  const raw = (r: LogRow): Line[] => (r.kind === "trace" ? r.lines : [r.line]);
  const trouble = useMemo(() => rows.filter((r) => r.kind === "trace" || (r.kind !== "start" && r.line.tone === "error")).length, [rows]);
  const toggle = useCallback((key: string) => setOpen((s) => { const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next; }), []);
  const only = useCallback((job: { id: string; label: string }) => setOnlyJob((cur) => (cur?.id === job.id ? null : job)), []);
  const visible = useMemo(() => (shown.length > drawn ? shown.slice(-drawn) : shown), [shown, drawn]);

  return (
    <div className="flex min-h-0 grow flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex h-8 w-72 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input data-search="log" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find in the log" className="min-w-0 grow bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
        </label>
        <button type="button" aria-pressed={onlyTrouble} onClick={() => setOnlyTrouble((v) => !v)} className={cx("h-8 rounded-lg border px-2.5 font-semibold", onlyTrouble ? "border-warn bg-warn-wash text-warn-ink" : "border-line-strong text-ink-2 hover:bg-hover hover:text-ink")}>
          Errors and warnings{trouble ? ` · ${trouble}` : ""}
        </button>
        <Button size="sm" aria-pressed={paused} onClick={() => setPaused((v) => !v)} data-tip={paused ? "Read the log again every two seconds" : "Stop reading: what is here stays put"}>{paused ? <Play size={13} /> : <Pause size={13} />} {paused ? "Resume" : "Pause"}</Button>
        <Button size="sm" onClick={() => { setLines([]); seen.current.clear(); }} data-tip="Empty this view. ComfyUI keeps its own log."><Eraser size={13} /> Clear view</Button>
        {onlyJob && (
          <button type="button" onClick={() => setOnlyJob(null)} data-tip="Show every job's lines again" className="flex h-8 max-w-72 items-center gap-1.5 rounded-lg border border-accent bg-accent-wash px-2.5 font-semibold text-accent">
            <span className="truncate">Only {onlyJob.label}</span> <X size={12} className="shrink-0" />
          </button>
        )}
        <Button size="sm" onClick={() => void copyText(shown.flatMap(raw).map((l) => `${l.t} ${l.m}`).join("\n")).catch(() => {})} data-tip="Copy the lines shown (tracebacks whole)"><Copy size={13} /> Copy</Button>
        {!stuck && <Button size="sm" tone="primary" onClick={() => { setStuck(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}><ArrowDownToLine size={13} /> Follow the end</Button>}
        <span className="grow" />
        <span className="text-ink-3">{shown.length} of {rows.length} rows{paused ? " · paused" : log.isFetching ? " · reading…" : ""} · read-only, straight from ComfyUI</span>
      </div>
      {!online && <ErrorNote>ComfyUI is offline: there is no log to read until it is back.</ErrorNote>}
      {online && log.isError && <ErrorNote>ComfyUI did not give its log: {log.error.message}</ErrorNote>}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 grow overflow-y-auto rounded-xl border border-line bg-ground p-3 font-mono text-[11.5px] leading-[1.45]"
      >
        {shown.length > visible.length && (
          <button type="button" onClick={() => setDrawn((n) => n + DRAWN)} className="mb-1.5 font-sans text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
            {shown.length - visible.length} earlier rows · show {Math.min(DRAWN, shown.length - visible.length)} more
          </button>
        )}
        <LogBody rows={visible} open={open} onToggle={toggle} onOnly={only} />
        {!shown.length && online && !log.isError && <span className="text-ink-3">{lines.length ? "Nothing matches." : "Waiting for ComfyUI's log…"}</span>}
      </div>
    </div>
  );
}

/** The rows drawn: held apart, so that a read of the queue (a progress event) does not draw them again. */
const LogBody = memo(function LogBody({ rows, open, onToggle, onOnly }: { rows: LogRow[]; open: Set<string>; onToggle(key: string): void; onOnly(job: { id: string; label: string }): void }) {
  const toneClass = (l: Line) => (l.tone === "error" ? "text-warn-ink" : l.tone === "warn" ? "text-picture" : l.tone === "mark" ? "text-accent" : "text-ink-2");
  return (
    <>
      {rows.map((r) => {
        if (r.kind === "start") {
          return (
            <div key={r.key} className="mt-1.5 flex gap-3 border-t border-line pt-1.5 whitespace-pre-wrap break-all text-accent">
              <span className="shrink-0 select-none text-ink-3">{clock(r.line.t)}</span>
              <span className="flex min-w-0 items-center gap-2">
                {r.line.m}
                {r.job && r.label && (
                  <button type="button" onClick={() => onOnly({ id: r.job!, label: r.label! })} data-tip="Only this job's lines" className="truncate rounded-md bg-accent-wash px-1.5 font-sans text-[11px] font-semibold hover:brightness-110">
                    {r.label}
                  </button>
                )}
              </span>
            </div>
          );
        }
        if (r.kind === "trace") {
          const unfolded = open.has(r.key);
          return (
            <div key={r.key} className="flex flex-col">
              <button type="button" onClick={() => onToggle(r.key)} aria-expanded={unfolded} data-tip={unfolded ? "Fold the traceback" : `The traceback, ${r.lines.length} lines`} className="flex gap-3 text-left whitespace-pre-wrap break-all text-warn-ink hover:brightness-110">
                <span className="shrink-0 select-none text-ink-3">{clock(r.last.t)}</span>
                <span className="flex min-w-0 items-start gap-1"><ChevronRight size={12} className={cx("mt-0.5 shrink-0 transition-transform", unfolded && "rotate-90")} /><span className="font-semibold">{r.last.m.trim()}</span></span>
              </button>
              {unfolded && r.lines.slice(0, -1).map((l) => (
                <div key={l.key} className="flex gap-3 whitespace-pre-wrap break-all text-ink-3">
                  <span className="invisible shrink-0 select-none">{clock(l.t)}</span>
                  <span>{l.m}</span>
                </div>
              ))}
            </div>
          );
        }
        return (
          <div key={r.key} className={cx("flex gap-3 whitespace-pre-wrap break-all", toneClass(r.line))}>
            <span className="shrink-0 select-none text-ink-3">{clock(r.line.t)}</span>
            <span>{r.line.m}{r.kind === "progress" && r.folded > 1 && <span className="ml-2 select-none text-ink-3" data-tip={`${r.folded} updates of this bar, the latest shown`}>×{r.folded}</span>}</span>
          </div>
        );
      })}
    </>
  );
});
