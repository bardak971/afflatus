import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronRight, Copy, Eraser, Pause, Play, Search } from "lucide-react";
import { api } from "../../api";
import { useQueueOf } from "../studio/queueOf";
import { logRows, type JobAt, type LogLine, type LogRow } from "./logRows";
import { copyText } from "../../secureContext";
import { Button, Chip, cx, ErrorNote, Failed, fieldClass, Toggle } from "../../ui";
import { queryKeys } from "../../queryKeys";

/**
 * ComfyUI's terminal, live: what it printed since the last read is fetched every two seconds and kept here as
 * it scrolls by (up to a few thousand lines), so that what a render printed is still there after the
 * next one. Errors and warnings are coloured, a prompt's start and end marked and named after its job (a click
 * shows only its lines), a progress bar folded into its latest, a traceback into its last line. The view follows
 * the end until it is scrolled up; only the rows in view (and a screen's worth around them) are drawn.
 */

type Line = LogLine;
const KEEP = 4000;
/** A row's height until it has been drawn once: one line of the log (11.5 px at 1.45). */
const ROW_GUESS = 17;
/** How far past the view rows are drawn, above and below, in px: a quick scroll shows no blank. */
const OVERSCAN = 600;
/** The log box's padding (p-3): where the first row starts. */
const PAD = 12;
const NO_JOBS: JobAt[] = [];

const toneOf = (m: string): Line["tone"] =>
  /\[ERROR\]|Traceback|Error:|error\b.*\bexecuting|CUDA out of memory|not enough memory/i.test(m) ? "error"
  : /\[WARN|warning/i.test(m) ? "warn"
  : /got prompt|Prompt executed in|Requested to load|Loaded completely|loaded completely/i.test(m) ? "mark"
  : "plain";
const clock = (t: string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t.slice(11, 19) : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

/** The row at height `y`: the last whose offset is not past it (offsets ascending, one more than the rows). */
const rowAt = (offsets: number[], y: number) => {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
};

export function ComfyLog({ online, pod = false, machine }: {
  online: boolean;
  /** A rented pod running or on its way up: while its ComfyUI does not answer, its boot log is read (the Afflatus image's). */
  pod?: boolean;
  /** With several ComfyUIs, whose log (a Machine's id); left out, the first one's. */
  machine?: string;
}) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [onlyTrouble, setOnlyTrouble] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [stuck, setStuck] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  // the stamp of the last line read, and whose log it is (the pod's boot log, or ComfyUI's): the next read asks only for what
  // came from then on in the same log
  const cursor = useRef<{ t: string; of: "boot" | "comfy" } | undefined>(undefined);
  // a read is appended once: not kept once the tab is left, or coming back would start with an old read's tail
  const log = useQuery({ queryKey: queryKeys.comfyLog(machine), queryFn: () => api.comfyLogs(cursor.current?.t, { machine, of: cursor.current?.of }), refetchInterval: paused ? false : 2000, enabled: online || pod, retry: 0, gcTime: 0 });
  const boot = log.data?.source === "boot";
  // the jobs a prompt may have run for: the one running and the recent ones; drawn again when they change, not at each progress event
  const jobs = useQueueOf((q) => [...(q.running ? [q.running] : []), ...q.recent].map((j) => ({ id: j.id, label: j.label, startedAt: j.startedAt ?? null }))) ?? NO_JOBS;
  const [onlyJob, setOnlyJob] = useState<{ id: string; label: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // the window: where the view is, and each row's height once drawn
  const [view, setView] = useState({ top: 0, height: 800 });
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState(0);

  // what came in since last time goes on the end; ComfyUI keeps a window, this keeps the scroll
  useEffect(() => {
    if (!log.data) return;
    const fresh: Line[] = [];
    const source = log.data.source ?? "comfy";
    // ComfyUI up after the pod's boot log: its own log follows, from its start (the boot log had those lines in its time)
    if (cursor.current && cursor.current.of !== source) {
      const at = log.data.lines[0]?.t ?? cursor.current.t;
      fresh.push({ key: `${at}\u0000source:${source}`, t: at, m: source === "comfy" ? "ComfyUI answers: its own log from here" : "ComfyUI does not answer: the pod's boot log from here", tone: "mark" });
    }
    for (const e of log.data.lines) {
      const key = `${e.t}\u0000${e.m}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh.push({ key, t: e.t, m: e.m, tone: toneOf(e.m) });
    }
    const last = log.data.lines.at(-1);
    if (last) cursor.current = { t: last.t, of: source };
    if (!fresh.length) return;
    setLines((all) => {
      const next = [...all, ...fresh];
      if (next.length > KEEP) {
        for (const gone of next.splice(0, next.length - KEEP)) {
          seen.current.delete(gone.key);
          heights.current.delete(gone.key);
        }
      }
      return next;
    });
  }, [log.data]);

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

  // where each shown row starts (its drawn height, else one line's), and the rows in view with the overscan
  const offsets = useMemo(() => {
    const at = [0];
    for (const r of shown) at.push(at[at.length - 1]! + (heights.current.get(r.key) ?? ROW_GUESS));
    return at;
  }, [shown, measured]); // eslint-disable-line react-hooks/exhaustive-deps -- measured is the signal that the heights in the ref changed
  const first = shown.length ? rowAt(offsets, view.top - OVERSCAN) : 0;
  const end = shown.length ? rowAt(offsets, view.top + view.height + OVERSCAN) + 1 : 0;
  const drawn = useMemo(() => shown.slice(first, end), [shown, first, end]);

  // the rows just drawn measured (a wrapped line, a traceback unfolded); then the end kept in view until the reader scrolls up
  // eslint-disable-next-line react-hooks/exhaustive-deps -- after every render on purpose: it sets state only when a height moved, so it settles
  useLayoutEffect(() => {
    let changed = false;
    for (const el of Array.from(body.current?.children ?? [])) {
      const key = (el as HTMLElement).dataset.key;
      if (!key) continue;
      const h = el.getBoundingClientRect().height;
      if (Math.abs((heights.current.get(key) ?? -1) - h) > 0.5) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    if (changed) setMeasured((n) => n + 1);
    const el = box.current;
    if (stuck && el && el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight;
  });
  // a box made taller or narrower: other rows in view, other wraps
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setView({ top: el.scrollTop - PAD, height: el.clientHeight });
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const clearView = () => {
    setLines([]);
    heights.current.clear();
    // the lines at the last stamp come again with the next read: still known, so they are not drawn again
    const at = cursor.current?.t;
    seen.current = new Set(at === undefined ? [] : [...seen.current].filter((k) => k.startsWith(`${at}\u0000`)));
  };

  return (
    <div className="flex min-h-0 grow flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="relative w-72">
          <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
          <input data-search="log" aria-label="Find in the log" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find in the log" className={cx(fieldClass, "h-8 w-full pl-7.5 text-xs")} />
        </span>
        <Toggle on={onlyTrouble} onChange={setOnlyTrouble} label={`Errors and warnings${trouble ? ` · ${trouble}` : ""}`} />
        <Button size="sm" aria-pressed={paused} onClick={() => setPaused((v) => !v)} data-tip={paused ? "Read the log again every two seconds" : "Stop reading: what is here stays put"}>{paused ? <Play size={13} /> : <Pause size={13} />} {paused ? "Resume" : "Pause"}</Button>
        <Button size="sm" onClick={clearView} data-tip="Empty this view. ComfyUI keeps its own log."><Eraser size={13} /> Clear view</Button>
        {onlyJob && (
          <Chip tone="link" truncate onRemove={() => setOnlyJob(null)} removeLabel="Show every job's lines again" className="max-w-72">
            Only {onlyJob.label}
          </Chip>
        )}
        <Button size="sm" onClick={() => void copyText(shown.flatMap(raw).map((l) => `${l.t} ${l.m}`).join("\n")).catch(() => {})} data-tip="Copy the lines shown (tracebacks whole)"><Copy size={13} /> Copy</Button>
        {!stuck && <Button size="sm" tone="primary" onClick={() => { setStuck(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}><ArrowDownToLine size={13} /> Follow the end</Button>}
        <span className="grow" />
        <span className="text-ink-3">{shown.length} of {rows.length} rows{paused ? " · paused" : log.isFetching ? " · reading…" : ""} · read-only, {boot ? "the pod's boot log until ComfyUI answers" : "straight from ComfyUI"}</span>
      </div>
      {!online && !pod && <ErrorNote>ComfyUI is offline: there is no log to read until it is back.</ErrorNote>}
      {(online || pod) && log.isError && <Failed what="ComfyUI did not give its log" error={log.error} />}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          setView({ top: el.scrollTop - PAD, height: el.clientHeight });
        }}
        className="min-h-0 grow overflow-y-auto rounded-xl border border-line bg-ground p-3 font-mono text-meta leading-[1.45]"
      >
        {/* the rows not drawn stand as room above and below, at their heights (one line's, until drawn once) */}
        <div ref={body} style={{ paddingTop: offsets[first], paddingBottom: offsets[shown.length]! - offsets[end]! }}>
          <LogBody rows={drawn} open={open} onToggle={toggle} onOnly={only} />
        </div>
        {!shown.length && (online || pod) && !log.isError && (
          <span className="text-ink-3">
            {lines.length ? "Nothing matches" : boot ? "No boot log yet: the pod's image is still being pulled, or it runs an image without one (RunPod's ComfyUI image, Afflatus's before 0.1.12)." : "Waiting for ComfyUI's log…"}
          </span>
        )}
      </div>
    </div>
  );
}

/** The rows drawn, each in a box of its own that is measured (its margin inside it): held apart, so that a scroll that keeps the same rows does not draw them again. */
const LogBody = memo(function LogBody({ rows, open, onToggle, onOnly }: { rows: LogRow[]; open: Set<string>; onToggle(key: string): void; onOnly(job: { id: string; label: string }): void }) {
  // the marks of a job's course (got prompt, executed, loaded) in the full ink, a step above the rest: the coral read as an error
  const toneClass = (l: Line) => (l.tone === "error" ? "text-warn-ink" : l.tone === "warn" ? "text-picture" : l.tone === "mark" ? "text-ink" : "text-ink-2");
  const one = (r: LogRow) => {
    if (r.kind === "start") {
      return (
        <div className="mt-1.5 flex gap-3 border-t border-line pt-1.5 whitespace-pre-wrap break-all font-semibold text-ink">
          <span className="shrink-0 select-none text-ink-3">{clock(r.line.t)}</span>
          <span className="flex min-w-0 items-center gap-2">
            {r.line.m}
            {r.job && r.label && (
              <button type="button" onClick={() => onOnly({ id: r.job!, label: r.label! })} data-tip="Only this job's lines" className="truncate rounded-md bg-hover px-1.5 font-sans text-meta font-semibold text-ink-2 hover:text-ink">
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
        <div className="flex flex-col">
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
      <div className={cx("flex gap-3 whitespace-pre-wrap break-all", toneClass(r.line))}>
        <span className="shrink-0 select-none text-ink-3">{clock(r.line.t)}</span>
        <span>{r.line.m}{r.kind === "progress" && r.folded > 1 && <span className="ml-2 select-none text-ink-3" data-tip={`${r.folded} updates of this bar, the latest shown`}>×{r.folded}</span>}</span>
      </div>
    );
  };
  return <>{rows.map((r) => <div key={r.key} data-key={r.key} className="flow-root">{one(r)}</div>)}</>;
});
