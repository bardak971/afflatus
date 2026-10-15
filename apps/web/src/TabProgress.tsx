import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Job } from "./api";
import { useQueue } from "./data";
import { clock, timeLeft } from "./format";
import { MARK_SMALL } from "./logo";
import { useThemeChoice } from "./theme/store";

const NAME = "Afflatus";
/**
 * The theme's colours, read off the page once per theme (a style read per drawing cost more than the drawing): the tab's
 * icon is in the theme and the accent that are up, on the dark of the stage as the rail's mark is (its accent is the one
 * tuned for the dark).
 */
type Tones = ReturnType<typeof colors>;
function colors() {
  const css = getComputedStyle(document.querySelector("[data-stage]") ?? document.documentElement);
  const token = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
  return { raised: token("raised"), track: token("line-strong"), accent: token("accent"), good: token("good"), warn: token("warn"), ink3: token("ink-3") };
}

type Mark = "done" | "failed" | "waiting" | null;

/**
 * The tab's icon, on the tile of the app's mark: while a render goes, a ring around the tile's edge that fills from
 * twelve o'clock (what still reads at the size a tab draws it) and the mark inside it; waiting, the mark dim and a dot;
 * done or failed while the tab was not looked at, a badge on its corner.
 */
let canvas: HTMLCanvasElement | null = null;
function icon(state: { progress: number | null; mark: Mark }, tone: Tones): string | null {
  const size = 64;
  // one canvas for every drawing
  canvas ??= Object.assign(document.createElement("canvas"), { width: size, height: size });
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.clearRect(0, 0, size, size);
  c.fillStyle = tone.raised;
  c.beginPath();
  c.roundRect(0, 0, size, size, 14);
  c.fill();
  const busy = state.progress !== null;
  if (busy) {
    const r = size / 2 - 4;
    c.lineWidth = 6;
    c.strokeStyle = tone.track;
    c.beginPath();
    c.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = tone.accent;
    c.lineCap = "round";
    c.beginPath();
    c.arc(size / 2, size / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0.01, state.progress!)));
    c.stroke();
  }
  // the app's mark: smaller inside the ring
  const scale = busy ? 0.32 : 0.46;
  c.save();
  c.translate(size / 2 - 50 * scale, size / 2 - 50 * scale);
  c.scale(scale, scale);
  c.fillStyle = c.strokeStyle = state.mark === "waiting" ? tone.ink3 : tone.accent;
  c.lineWidth = 1;
  c.lineJoin = "round";
  for (const d of [MARK_SMALL.body, MARK_SMALL.spark]) {
    const p = new Path2D(d);
    c.fill(p, "evenodd");
    c.stroke(p);
  }
  c.restore();
  if (state.mark === "waiting") {
    c.fillStyle = tone.accent;
    c.beginPath();
    c.arc(size - 15, 15, 9, 0, Math.PI * 2);
    c.fill();
  } else if (state.mark === "done" || state.mark === "failed") {
    // the badge, cut out of the tile by a ring of the tile's own colour
    const [x, y] = [size - 16, size - 16];
    c.fillStyle = tone.raised;
    c.beginPath();
    c.arc(x, y, 17, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = state.mark === "done" ? tone.good : tone.warn;
    c.beginPath();
    c.arc(x, y, 13, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = c.fillStyle = tone.raised;
    c.lineWidth = 4;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    if (state.mark === "done") {
      c.moveTo(x - 6, y);
      c.lineTo(x - 1.5, y + 5);
      c.lineTo(x + 6.5, y - 5);
      c.stroke();
    } else {
      c.moveTo(x, y - 6.5);
      c.lineTo(x, y + 1.5);
      c.stroke();
      c.beginPath();
      c.arc(x, y + 6.5, 2.2, 0, Math.PI * 2);
      c.fill();
    }
  }
  return canvas.toDataURL("image/png");
}

const LOOK_EVENTS = ["visibilitychange", "focus", "blur"] as const;
const lookedNow = () => !document.hidden && document.hasFocus();
/** Whether the page is in front and has the focus: its tab's icon is not what is looked at then. */
function useLooked(): boolean {
  return useSyncExternalStore(
    (changed) => {
      for (const e of LOOK_EVENTS) (e === "visibilitychange" ? document : window).addEventListener(e, changed);
      return () => {
        for (const e of LOOK_EVENTS) (e === "visibilitychange" ? document : window).removeEventListener(e, changed);
      };
    },
    lookedNow,
    () => false,
  );
}

/** A job in a word or two for the tab: "Clip 3" for a clip's take, else the start of its name. */
function shortName(label: string): string {
  const clip = /·\s*clip (\d+)(?:\s*·.*)?$/i.exec(label);
  if (clip) return `Clip ${clip[1]}`;
  return label.length > 28 ? `${label.slice(0, 27).trimEnd()}…` : label;
}
const took = (j: Job) => (j.startedAt && j.finishedAt ? clock(new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) : null);

/**
 * The browser tab says how the render is going, for when another tab or window is in front: the percentage, the time
 * left and what renders in its title, and a ring in its icon. What finished or failed while the tab was not looked at
 * stays said (which job, how long it took) until it is looked at.
 */
export function TabProgress() {
  const queue = useQueue();
  const [unseen, setUnseen] = useState<{ mark: "done" | "failed"; job: Job | null } | null>(null);
  const wasBusy = useRef(false);
  const lastFailed = useRef<string | null | undefined>(undefined);
  const run = queue.data?.running ?? null;
  const waiting = queue.data?.waiting.length ?? 0;
  // a model loaded ahead (a "load") is not a render: never the one said as done or failed
  const failedJob = queue.data?.recent.find((j) => j.status === "failed" && j.kind !== "load") ?? null;
  const failed = failedJob?.id ?? null;

  useEffect(() => {
    if (!queue.data) return;
    if (run || waiting) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      if (document.hidden) setUnseen((u) => u ?? { mark: "done", job: queue.data!.recent.find((j) => j.status === "done" && j.kind !== "load") ?? null });
    }
    // a render that failed since the page was last looked at
    if (lastFailed.current !== undefined && failed && failed !== lastFailed.current && document.hidden) setUnseen({ mark: "failed", job: failedJob });
    lastFailed.current = failed;
  }, [queue.data, run, waiting, failed, failedJob]);

  useEffect(() => {
    const seen = () => !document.hidden && setUnseen(null);
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, []);

  // a whole percent at a time in the title: it is not changed for every event of a render
  const percent = run ? Math.round(run.progress * 100) : null;
  const paused = Boolean(queue.data?.paused) && !run;
  const left = run?.eta ? timeLeft(run.eta) : null;
  const what = run ? shortName(run.label) : null;
  // redrawn in a new theme or accent
  const theme = useThemeChoice();

  useEffect(() => {
    const more = waiting ? `+${waiting}` : null;
    document.title = percent !== null
      ? [`${percent}%`, left, what, more, NAME].filter(Boolean).join(" · ")
      : unseen?.mark === "failed"
        ? `✗ ${unseen.job ? `${shortName(unseen.job.label)} failed` : "failed"} · ${NAME}`
        : waiting
          ? `${paused ? "Paused" : "Queued"} ${waiting} · ${NAME}`
          : unseen?.mark === "done"
            ? `✓ ${unseen.job ? [shortName(unseen.job.label), took(unseen.job)].filter(Boolean).join(" · ") : "done"} · ${NAME}`
            : NAME;
  }, [percent, left, what, waiting, unseen, paused]);

  // the icon's ring in 5 % steps, and held where it is while the page is looked at (the tab's icon is not what is read
  // then): a render drew it again ~3.6 times a second, each a canvas encoded to a PNG on the page's thread
  const looked = useLooked();
  const drawn = useRef<number | null>(null);
  const ring = percent === null ? null : looked && drawn.current !== null ? drawn.current : Math.floor(percent / 5) * 5;
  const mark: Mark = percent !== null ? null : unseen?.mark ?? (waiting ? "waiting" : null);
  const tones = useRef<{ theme: typeof theme; tones: Tones } | null>(null);
  const lastDraw = useRef(0);

  useEffect(() => {
    // a frame later (a new theme is put on the page by an effect that runs after this one), and at most once a second
    let frame = 0;
    const wait = Math.max(0, lastDraw.current + 1000 - performance.now());
    const timer = window.setTimeout(() => (frame = requestAnimationFrame(() => {
      if (tones.current?.theme !== theme) tones.current = { theme, tones: colors() };
      const href = icon({ progress: ring === null ? null : ring / 100, mark }, tones.current.tones);
      lastDraw.current = performance.now();
      drawn.current = ring;
      if (!href) return;
      // one icon: the files in public/ are the first paint's only
      document.querySelectorAll('link[rel="icon"]').forEach((l, i) => i > 0 && l.remove());
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.type = "image/png";
      link.removeAttribute("sizes");
      link.href = href;
    })), wait);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [ring, mark, theme]);

  return null;
}
