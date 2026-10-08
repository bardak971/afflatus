import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Copy, Eraser, Pause, Play, Search } from "lucide-react";
import { api } from "../../api";
import { copyText } from "../../secureContext";
import { Button, cx, ErrorNote } from "../../ui";

/**
 * ComfyUI's terminal, live: its last few hundred lines are read every two seconds and kept here as
 * they scroll by (up to a few thousand), so that what a render printed is still there after the
 * next one. Errors and warnings are coloured, a prompt's start and end marked. The view follows the
 * end until it is scrolled up.
 */

interface Line { key: string; t: string; m: string; tone: "error" | "warn" | "mark" | "plain" }
const KEEP = 4000;

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

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return lines.filter((l) => (!onlyTrouble || l.tone === "error" || l.tone === "warn") && (!q || l.m.toLowerCase().includes(q)));
  }, [lines, filter, onlyTrouble]);
  const trouble = lines.filter((l) => l.tone === "error").length;

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
        <Button size="sm" onClick={() => void copyText(shown.map((l) => `${l.t} ${l.m}`).join("\n")).catch(() => {})} data-tip="Copy the lines shown"><Copy size={13} /> Copy</Button>
        {!stuck && <Button size="sm" tone="primary" onClick={() => { setStuck(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}><ArrowDownToLine size={13} /> Follow the end</Button>}
        <span className="grow" />
        <span className="text-ink-3">{shown.length} of {lines.length} lines{paused ? " · paused" : log.isFetching ? " · reading…" : ""} · read-only, straight from ComfyUI</span>
      </div>
      {!online && <ErrorNote>ComfyUI is offline: there is no log to read until it is back.</ErrorNote>}
      {log.isError && <ErrorNote>{log.error.message}</ErrorNote>}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 grow overflow-y-auto rounded-xl border border-line bg-ground p-3 font-mono text-[11.5px] leading-[1.45]"
      >
        {shown.map((l) => (
          <div key={l.key} className={cx("flex gap-3 whitespace-pre-wrap break-all", l.tone === "error" ? "text-warn-ink" : l.tone === "warn" ? "text-picture" : l.tone === "mark" ? "text-accent" : "text-ink-2")}>
            <span className="shrink-0 select-none text-ink-3">{clock(l.t)}</span>
            <span>{l.m}</span>
          </div>
        ))}
        {!shown.length && online && <span className="text-ink-3">{lines.length ? "Nothing matches." : "Waiting for ComfyUI's log…"}</span>}
      </div>
    </div>
  );
}
