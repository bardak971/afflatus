import { useEffect, useRef, useState } from "react";
import { useQueue } from "./data";

const NAME = "Afflatus";
const COLORS = { ground: "#0f1114", track: "#2a2e36", accent: "#f5c451", good: "#5ad6bd", warn: "#ff8a5c", ink: "#ecedf0" };

/** The tab's icon: the app's letter, and under it a bar that fills as the render goes, or a mark for what it ended as. */
function icon(state: { progress: number | null; mark: "done" | "failed" | "waiting" | null }): string | null {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.fillStyle = COLORS.ground;
  c.beginPath();
  c.roundRect(0, 0, size, size, 14);
  c.fill();
  const busy = state.progress !== null;
  c.fillStyle = state.mark === "done" ? COLORS.good : state.mark === "failed" ? COLORS.warn : COLORS.accent;
  c.font = `bold ${busy ? 38 : 46}px system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(state.mark === "done" ? "✓" : state.mark === "failed" ? "!" : "s", size / 2, busy ? 24 : 32);
  if (busy) {
    // a bar across the bottom: it is what stays readable at the size a tab draws it
    const [x, y, w, h] = [6, 44, size - 12, 14];
    c.fillStyle = COLORS.track;
    c.beginPath();
    c.roundRect(x, y, w, h, 7);
    c.fill();
    c.fillStyle = COLORS.accent;
    c.beginPath();
    c.roundRect(x, y, Math.max(h, w * Math.min(1, Math.max(0, state.progress!))), h, 7);
    c.fill();
  } else if (state.mark === "waiting") {
    c.fillStyle = COLORS.ink;
    c.beginPath();
    c.arc(size - 13, 13, 8, 0, Math.PI * 2);
    c.fill();
  }
  return canvas.toDataURL("image/png");
}

/**
 * The browser tab says how the render is going, for when another tab or window is in front: the
 * percentage in its title, and a bar in its icon. What finished or failed while the tab was not
 * looked at stays said until it is looked at.
 */
export function TabProgress() {
  const queue = useQueue();
  const [unseen, setUnseen] = useState<"done" | "failed" | null>(null);
  const wasBusy = useRef(false);
  const lastFailed = useRef<string | null | undefined>(undefined);
  const run = queue.data?.running ?? null;
  const waiting = queue.data?.waiting.length ?? 0;
  const failed = queue.data?.recent.find((j) => j.status === "failed")?.id ?? null;

  useEffect(() => {
    if (!queue.data) return;
    if (run || waiting) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      if (document.hidden) setUnseen((u) => u ?? "done");
    }
    // a render that failed since the page was last looked at
    if (lastFailed.current !== undefined && failed && failed !== lastFailed.current && document.hidden) setUnseen("failed");
    lastFailed.current = failed;
  }, [queue.data, run, waiting, failed]);

  useEffect(() => {
    const seen = () => !document.hidden && setUnseen(null);
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, []);

  // a whole percent at a time: the title and the icon are not redrawn for every event of a render
  const percent = run ? Math.round(run.progress * 100) : null;
  const paused = Boolean(queue.data?.paused) && !run;
  useEffect(() => {
    document.title = percent !== null
      ? `${percent}%${waiting ? ` +${waiting}` : ""} · ${NAME}`
      : unseen === "failed"
        ? `✗ failed · ${NAME}`
        : waiting
          ? `${paused ? "Paused" : "Queued"}: ${waiting} · ${NAME}`
          : unseen === "done"
            ? `✓ done · ${NAME}`
            : NAME;
    const href = icon({ progress: percent === null ? null : percent / 100, mark: percent !== null ? null : unseen ?? (waiting ? "waiting" : null) });
    if (!href) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = href;
  }, [percent, waiting, unseen, paused]);

  return null;
}
