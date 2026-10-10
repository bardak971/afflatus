import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { api, type Asset } from "./api";
import { clock, when } from "./format";
import { leftOf } from "./screens/library/justify";
import { leftWords } from "./screens/studio/expiring";
import { queryKeys } from "./queryKeys";

/** How long the pointer rests on a tile before its tooltip shows. */
const TILE_TIP_AFTER_MS = 800;

/** How far the pointer moves (px) before a tile counts as no longer rested on: the tip goes, and waits for the next rest. */
const MOVED_PX = 6;

/** The tooltip's timer and place, for a tile: rest on it to show; move on it, leave it or press to hide. */
export function useTileTip() {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rest = useRef<{ x: number; y: number } | null>(null);
  const restOn = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setTip({ left: r.left, top: r.bottom });
    }, TILE_TIP_AFTER_MS);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // moving along a tile (a video scrubbing, a sound followed) is not resting on it: the tip waits for the pointer to stop
  const moved = (e: { currentTarget: HTMLElement; clientX: number; clientY: number }) => {
    const r = rest.current;
    if (r && Math.abs(e.clientX - r.x) < MOVED_PX && Math.abs(e.clientY - r.y) < MOVED_PX) return;
    rest.current = { x: e.clientX, y: e.clientY };
    setTip(null);
    restOn(e.currentTarget);
  };
  return {
    tip, restOn, leave,
    props: {
      onPointerEnter: (e: { currentTarget: HTMLElement; clientX: number; clientY: number }) => {
        rest.current = { x: e.clientX, y: e.clientY };
        restOn(e.currentTarget);
      },
      onPointerMove: moved,
      onPointerLeave: leave,
      onPointerDown: leave,
    },
  };
}

const origins: Record<string, string> = { generated: "Generated", uploaded: "Uploaded", imported: "Imported", exported: "Timeline export", frame: "Video frame" };

/**
 * What a picture, video or sound is, read without opening it: shown after the pointer has rested on its
 * tile, in the library and in a timeline's media. Its name first, then what it is (kind, size, length, when), where it is used
 * (a timeline's clip), its seed and what it was made from. Neither the prompt nor the model name: those are
 * in the details.
 */
export function TileTip({ asset, at }: { asset: Asset; at: { left: number; top: number } }) {
  // the render's seed and lineage, read when the tip shows (kept for the session)
  const detail = useQuery({ queryKey: queryKeys.assets.one(asset.id), queryFn: ({ signal }) => api.asset(asset.id, { signal }), enabled: asset.origin === "generated", staleTime: 5 * 60_000 });
  const g = detail.data?.generation;
  const lines: Array<{ text: string; tone?: "dim" }> = [];
  const what = asset.kind === "audio" && asset.origin === "imported" ? "Extracted audio" : (origins[asset.origin] ?? asset.origin);
  const size = asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : "";
  const length = asset.durationMs ? ` · ${clock(asset.durationMs)}` : "";
  if (asset.name) lines.push({ text: asset.name });
  lines.push({ text: `${what}${size}${length}${asset.kind === "video" && asset.hasSound === false ? " · silent" : ""}` });
  // expiring (nobody kept it): what its corner clock stands for, said in words
  const expiresIn = !asset.kept && !asset.inBin ? leftOf(asset) : null;
  const unkept = expiresIn !== null ? ` · expires in ${leftWords(expiresIn)}` : asset.kept || asset.inBin ? "" : " · not kept";
  lines.push({ text: `${when(asset.createdAt)}${asset.kept ? " · kept" : unkept}${asset.inBin ? " · in the bin" : ""}`, tone: "dim" });
  const of = asset.clipOf;
  if (of) lines.push({ text: `Clip ${of.clip} of ${of.timelineName}${of.takes > 1 ? ` · take ${of.take} of ${of.takes}` : ""}${of.playing ? "" : " · not the one that plays"}` });
  if (g) {
    const seed = g.resolved?.seed;
    const from = detail.data?.sources.length ?? 0;
    const bits = [seed !== undefined ? `seed ${seed}` : "", from ? `from ${from} ${from > 1 ? "pictures" : "picture"}` : "", g.tookMs ? `rendered in ${clock(g.tookMs)}` : ""].filter(Boolean);
    if (bits.length) lines.push({ text: bits.join(" · "), tone: "dim" });
  }
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 272));
  const top = at.top + 6 > window.innerHeight - 140 ? Math.max(8, at.top - 150) : at.top + 6;
  return createPortal(
    <div role="tooltip" className="pointer-events-none fixed z-50 flex w-64 flex-col gap-0.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs shadow-lg" style={{ left, top }}>
      {lines.map((l, i) => (
        <span key={i} className={l.tone === "dim" ? "text-ink-2" : i === 0 ? "font-semibold text-ink" : "text-ink"}>{l.text}</span>
      ))}
    </div>,
    document.body,
  );
}
