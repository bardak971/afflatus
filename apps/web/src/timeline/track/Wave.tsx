/** How loud a sound is along a stretch of it, drawn behind the words of its row: -60 dB is the floor, 0 the top. */
export function Wave({ sound, rate, fromMs, toMs }: { sound: number[] | null; rate: number; fromMs: number; toMs: number }) {
  if (!sound || sound.length < 2) return null;
  const step = 1000 / rate;
  const a = Math.max(0, Math.floor(fromMs / step));
  const b = Math.min(sound.length - 1, Math.ceil(toMs / step));
  const vals = sound.slice(a, b + 1).map((db) => Math.max(0, Math.min(1, (db + 60) / 60)));
  if (vals.length < 2) return null;
  const W = 200;
  const H = 10;
  const d = `M0 ${H} ${vals.map((v, i) => `L${((i / (vals.length - 1)) * W).toFixed(1)} ${(H - v * H).toFixed(2)}`).join(" ")} L${W} ${H} Z`;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={d} fill="currentColor" opacity={0.3} />
    </svg>
  );
}
