/**
 * The bar's calculator (`=`): the figures video work needs, on the grid of the model in play (its frames on
 * `step·k + offset` at its frames a second, its sizes on a multiple of its grid), or plain arithmetic. Pure:
 * the grid is handed in, read from the recipe (traits.frameGrid, the size input's grid).
 */

export interface Grid {
  /** The model it is the grid of, as it is said ("H3"). */
  name: string;
  fps: number;
  /** Valid frame counts: step·k + offset. */
  frames: { step: number; offset: number };
  /** Both edges of a frame are multiples of this. */
  size: number;
}

/** One answer: a figure, what it is, a line about it, and what Enter copies. */
export interface CalcCard {
  label: string;
  value: string;
  note: string;
  copy: string;
}

/** The frame count on the grid at or above `frames` (a clip asked for that long gets at least that long). */
export const gridFramesAtLeast = (frames: number, g: Grid["frames"]) => Math.max(g.offset, Math.ceil((frames - g.offset) / g.step) * g.step + g.offset);
/** The frame count on the grid nearest to `frames`. */
export const gridFramesNearest = (frames: number, g: Grid["frames"]) => Math.max(g.offset, Math.round((frames - g.offset) / g.step) * g.step + g.offset);
const onGrid = (frames: number, g: Grid["frames"]) => frames >= g.offset && (frames - g.offset) % g.step === 0;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** The proportions people say, for a frame that is near one of them. */
const RATIOS: Array<[number, number]> = [[9, 16], [2, 3], [3, 4], [4, 5], [1, 1], [5, 4], [4, 3], [3, 2], [16, 9], [21, 9], [9, 21]];
/** "9:16", or "≈ 9:16" when it is near one people say, else the reduced proportions. */
export function ratioOf(w: number, h: number): string {
  const d = gcd(w, h);
  const exact = `${w / d}:${h / d}`;
  if (w / d <= 32 && h / d <= 32) return exact;
  const near = RATIOS.find(([a, b]) => Math.abs(w / h - a / b) / (a / b) < 0.012);
  return near ? `≈ ${near[0]}:${near[1]}` : `${(w / h).toFixed(3)}:1`;
}
const mp = (w: number, h: number) => {
  const v = (w * h) / 1e6;
  return `${v.toFixed(v < 1 ? 2 : 1)} MP`;
};
const secs = (s: number) => `${s.toFixed(2).replace(/\.?0+$/, "")} s`;
/**
 * A frame from proportions and a number of pixels, each edge on the grid: the long edge snapped first, the
 * short one from it, so that the proportions stay as near as the grid allows (9:16 at 1 MP → 768×1344).
 */
export function sizeFor(rw: number, rh: number, pixels: number, grid: number): { width: number; height: number } {
  const snap = (n: number) => Math.max(grid, Math.round(n / grid) * grid);
  const tall = rh >= rw;
  const long = snap(Math.sqrt((pixels * Math.max(rw, rh)) / Math.min(rw, rh)));
  const short = snap((long * Math.min(rw, rh)) / Math.max(rw, rh));
  return tall ? { width: short, height: long } : { width: long, height: short };
}

const DURATION = /(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|seconds?)\b/i;
const FRAMES = /(\d+)\s*(?:f|fr|frames?)\b/i;
const FPS = /(\d+(?:[.,]\d+)?)\s*fps\b/i;
// a size is the whole of what is typed: "17*10+5" is a sum, not a frame of 17×10 with something after it
const SIZE = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i;
const RATIO = /(\d{1,2}(?:\.\d+)?)\s*:\s*(\d{1,2}(?:\.\d+)?)/;
const MEGAPIXELS = /(\d+(?:[.,]\d+)?)\s*(?:mp|megapixels?)\b/i;
const n = (s: string) => Number(s.replace(",", "."));

/** What `text` asks, worked out on `grid`; null when it asks nothing the calculator knows. */
export function calc(text: string, grid: Grid): CalcCard[] | null {
  const t = text.trim();
  if (!t) return null;
  const fpsMatch = FPS.exec(t);
  const fps = fpsMatch ? n(fpsMatch[1]!) : grid.fps;
  const fpsSaid = `${fps} fps`;
  const rest = fpsMatch ? t.replace(fpsMatch[0], " ") : t;

  const frames = FRAMES.exec(rest);
  if (frames) {
    const f = Number(frames[1]);
    if (!f || !fps) return null;
    const cards: CalcCard[] = [{ label: "length", value: secs(f / fps), note: `${f} frames at ${fpsSaid} · Enter copies`, copy: (f / fps).toFixed(2) }];
    if (!onGrid(f, grid.frames)) {
      const near = gridFramesNearest(f, grid.frames);
      cards.push({ label: `nearest on the ${grid.name} grid`, value: `${near} f`, note: `${grid.frames.step}k+${grid.frames.offset} · ${secs(near / fps)}`, copy: String(near) });
    } else cards.push({ label: `on the ${grid.name} grid`, value: "yes", note: `${grid.frames.step}k+${grid.frames.offset} · k = ${(f - grid.frames.offset) / grid.frames.step}`, copy: String(f) });
    return cards;
  }

  const duration = DURATION.exec(rest);
  if (duration) {
    const s = n(duration[1]!);
    if (!(s > 0) || !fps) return null;
    const raw = Math.round(s * fps);
    const g = gridFramesAtLeast(raw, grid.frames);
    return [
      { label: "frames", value: String(g), note: `${grid.name} grid ${grid.frames.step}k+${grid.frames.offset} · ${secs(g / fps)} · Enter copies`, copy: String(g) },
      { label: "frames, plain", value: String(raw), note: `${secs(s)} × ${fpsSaid}`, copy: String(raw) },
    ];
  }

  const size = SIZE.exec(rest);
  if (size) {
    const w = Number(size[1]);
    const h = Number(size[2]);
    const cards: CalcCard[] = [
      { label: "pixels", value: mp(w, h), note: `${ratioOf(w, h)} · ${w}×${h} · Enter copies`, copy: `${w}x${h}` },
    ];
    const snapped = { width: Math.max(grid.size, Math.round(w / grid.size) * grid.size), height: Math.max(grid.size, Math.round(h / grid.size) * grid.size) };
    if (snapped.width !== w || snapped.height !== h) cards.push({ label: `on the ${grid.name} grid`, value: `${snapped.width}×${snapped.height}`, note: `edges on ${grid.size} · ${mp(snapped.width, snapped.height)}`, copy: `${snapped.width}x${snapped.height}` });
    else cards.push({ label: `on the ${grid.name} grid`, value: "yes", note: `both edges are multiples of ${grid.size}`, copy: `${w}x${h}` });
    return cards;
  }

  const ratio = RATIO.exec(rest);
  if (ratio) {
    const rw = n(ratio[1]!);
    const rh = n(ratio[2]!);
    if (!(rw > 0 && rh > 0)) return null;
    const mpMatch = MEGAPIXELS.exec(rest.replace(ratio[0], " "));
    const pixels = (mpMatch ? n(mpMatch[1]!) : 1) * 1e6;
    if (!(pixels > 0) || pixels > 64e6) return null;
    const s = sizeFor(rw, rh, pixels, grid.size);
    return [{ label: `${rw}:${rh} at ${mpMatch ? mpMatch[1] : "1"} MP`, value: `${s.width}×${s.height}`, note: `snapped to ${grid.size} for ${grid.name} · ${mp(s.width, s.height)} · Enter copies`, copy: `${s.width}x${s.height}` }];
  }

  const value = arithmetic(t);
  if (value === null) return null;
  const said = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  return [{ label: "result", value: said, note: "Enter copies", copy: said }];
}

/**
 * + − × ÷, powers and brackets, nothing else: a small reader, not eval. Null when it is not a sum
 * (a word, an unclosed bracket) or does not come to a finite number.
 */
export function arithmetic(text: string): number | null {
  const src = text.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/,/g, ".");
  if (!src || !/^[\d.+\-*/^()%]+$/.test(src) || !/\d/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = src[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[i++];
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (peek() === "^") {
      i++;
      return b ** power();
    }
    return b;
  };
  const unary = (): number => {
    if (peek() === "-") {
      i++;
      return -unary();
    }
    if (peek() === "+") {
      i++;
      return unary();
    }
    if (peek() === "(") {
      i++;
      const v = expr();
      if (src[i++] !== ")") throw new Error("bracket");
      return v;
    }
    const m = /^\d*\.?\d+/.exec(src.slice(i));
    if (!m) throw new Error("number");
    i += m[0].length;
    return Number(m[0]);
  };
  try {
    const v = expr();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
