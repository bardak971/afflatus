import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { dialogOver } from "../Dialog";
import { frameSpan, stepFrames } from "../frameStep";
import type { Range } from "./range";

/**
 * Trim's keys: I / O set in and out on the frame shown (in on it, out after it), , and . step one frame, ← and → too
 * (Shift: ten), L loops the range, Z zooms to it and back, Space plays, Home / End, Esc leaves. Bound once, reading the
 * playhead, the range and the zoom as they stand (the playhead moves with every frame decoded; a listener bound again each
 * time would be the dearest part of playing).
 */
export function useTrimKeys(o: {
  root: RefObject<HTMLDivElement | null>;
  player: RefObject<HTMLVideoElement | null>;
  duration: number;
  fps: number;
  frameMs: number;
  at: number;
  range: Range;
  zoom: Range | null;
  setRange: Dispatch<SetStateAction<Range>>;
  seek(ms: number): void;
  zoomTo(win: Range | null): void;
  roomy(r: Range): Range;
  toggleLoop(): void;
  onClose(): void;
}) {
  const { root, player, duration, fps, frameMs, setRange, seek, zoomTo, roomy } = o;
  const now = useRef({ at: o.at, range: o.range, zoom: o.zoom, toggleLoop: o.toggleLoop, onClose: o.onClose });
  now.current = { at: o.at, range: o.range, zoom: o.zoom, toggleLoop: o.toggleLoop, onClose: o.onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a modal over Trim (the keyboard shortcuts, a question) has the keys: the arrows must not step the video behind it
      if (dialogOver(root.current)) return;
      const el = e.target as Partial<HTMLElement> | null;
      if (typeof el?.closest === "function" && el.closest("input, textarea, select, [contenteditable], [role=listbox]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = player.current;
      const { at, range, zoom } = now.current;
      // , and . are one frame on every layout: on AZERTY "." is itself Shift + ";", so Shift cannot mean ten there.
      // Ten frames is Shift with the arrows, as in the timeline
      const arrows = e.shiftKey ? 10 : 1;
      const shown = frameSpan(at, fps);
      switch (e.key) {
        case "i": case "I": e.preventDefault(); setRange((r) => ({ startMs: Math.min(shown.startMs, r.endMs - frameMs), endMs: r.endMs })); break;
        case "o": case "O": e.preventDefault(); setRange((r) => ({ startMs: r.startMs, endMs: Math.min(duration, Math.max(shown.endMs, r.startMs + frameMs)) })); break;
        case ",": case "<": e.preventDefault(); v?.pause(); seek(stepFrames(at, -1, fps, duration)); break;
        case ".": case ">": e.preventDefault(); v?.pause(); seek(stepFrames(at, 1, fps, duration)); break;
        case "ArrowLeft": e.preventDefault(); v?.pause(); seek(stepFrames(at, -arrows, fps, duration)); break;
        case "ArrowRight": e.preventDefault(); v?.pause(); seek(stepFrames(at, arrows, fps, duration)); break;
        case "l": case "L": e.preventDefault(); now.current.toggleLoop(); break;
        case "z": case "Z": e.preventDefault(); zoomTo(zoom ? null : roomy(range)); break;
        case " ": e.preventDefault(); if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } break;
        case "Home": e.preventDefault(); seek(0); break;
        case "End": e.preventDefault(); seek(duration); break;
        case "Escape": e.preventDefault(); now.current.onClose(); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration, fps, frameMs, player, seek, zoomTo, roomy, root, setRange]);
}
