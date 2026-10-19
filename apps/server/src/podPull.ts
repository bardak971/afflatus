import type { ImageLayer } from "./podImage";

/**
 * A pod's image pull as its RunPod system log tells it (Runpod.systemLog), for its card while it boots ("pulling image ·
 * 1.9 / 4.7 GB · 35 MB/s · ~2 min left") and its session afterwards (how fast this host pulled, and whether it pulled at all).
 *
 * The log names each layer by its digest's first 12 hex, and its steps: "Pulling fs layer", "Already exists" (the host has
 * it), "Downloading", "Download complete", "Extracting", "Pull complete"; then "Status: Downloaded newer image" (pulled) or
 * "Status: Image is up to date" (the host had it all). It gives no byte counts, but a "Downloading" line comes about every
 * 5 MB of a layer (5.1-5.2 MB on every layer of a pull read on 2026-10-19, small and big alike), so the lines of a layer
 * still coming, against the layers already in, say how far it is. Its times are to the second.
 *
 * Docker extracts the layers one after the other in their order, each once its download is in and the ones before it are
 * extracted: on a fast host about a third of a pull (a 3.7 GB layer took 46 s), so the time left counts it too.
 */

export interface PullLine {
  ts: string;
  line: string;
}

export interface PullState {
  /** waiting: RunPod has not begun the pull (no host yet, or its log says nothing of it); done: the container can start. */
  phase: "waiting" | "downloading" | "extracting" | "done";
  /** It downloaded something (true), the host had it all (false); null while not known. */
  fresh: boolean | null;
  /** Bytes to download (the layers the host does not have), and downloaded so far, worked out from the log's lines. */
  bytes: number;
  done: number;
  /** Over the last minute of its download (MB/s, 10⁶ bytes); null before a few seconds of it. */
  mbps: number | null;
  /** How long it has left, its extraction included (ms); null while not known. */
  leftMs: number | null;
  /** From its first download to its last (ms), and from its first extraction to the pull's end (ms), once each is over. */
  downloadMs: number | null;
  extractMs: number | null;
}

/** What one "Downloading" line stands for before a layer of this pull is in to measure it by (bytes). */
const PER_LINE = 5.15e6;
/** How fast a host extracts before one of this pull's layers is extracted to measure it by (bytes/s): 3.7 GB in 46 s. */
const EXTRACT_RATE = 80e6;
/** A layer this big is measured for its extraction's speed (bytes). */
const BIG_LAYER = 500e6;
/** The span the speed is read over (ms): long enough to smooth the log's whole seconds, short enough to follow a crawl. */
const WINDOW_MS = 60_000;

const LAYER = /^([0-9a-f]{12}) (Pulling fs layer|Already exists|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete)/;

interface Layer {
  size: number | null;
  /** Its "Downloading" lines' times (ms). */
  lines: number[];
  had: boolean;
  downloaded: number | null;
  extractFrom: number | null;
  extracted: number | null;
}

function layersOf(lines: readonly PullLine[], sizes: ReadonlyMap<string, number>, until: number): { layers: Map<string, Layer>; first: number | null; end: number | null; upToDate: boolean } {
  const layers = new Map<string, Layer>();
  let first: number | null = null;
  let end: number | null = null;
  let upToDate = false;
  for (const l of lines) {
    const t = Date.parse(l.ts);
    if (!Number.isFinite(t) || t > until) continue;
    if (/^Status: Downloaded newer image/.test(l.line)) end ??= t;
    if (/^Status: Image is up to date/.test(l.line)) {
      upToDate = true;
      end ??= t;
    }
    const m = LAYER.exec(l.line);
    if (!m) continue;
    const id = m[1]!;
    const x = layers.get(id) ?? { size: sizes.get(id) ?? null, lines: [], had: false, downloaded: null, extractFrom: null, extracted: null };
    layers.set(id, x);
    switch (m[2]) {
      case "Already exists": x.had = true; break;
      case "Downloading": x.lines.push(t); first ??= t; break;
      case "Download complete": x.downloaded ??= t; break;
      case "Extracting": x.extractFrom ??= t; break;
      case "Pull complete": x.extracted ??= t; x.downloaded ??= t; break;
    }
  }
  return { layers, first, end, upToDate };
}

/** What one "Downloading" line stands for in this pull: its layers already in, measured; else PER_LINE. */
function perLine(layers: Iterable<Layer>): number {
  let bytes = 0;
  let count = 0;
  for (const x of layers) {
    if (x.downloaded === null || x.size === null || x.lines.length < 5) continue;
    bytes += x.size;
    count += x.lines.length;
  }
  return count ? bytes / count : PER_LINE;
}

/** Bytes downloaded by `until`: the layers in, whole, and of the others what their lines say, never all of one. */
function doneBy(layers: Iterable<Layer>, per: number, until: number): number {
  let done = 0;
  for (const x of layers) {
    if (x.had || x.size === null) continue;
    if (x.downloaded !== null && x.downloaded <= until) done += x.size;
    else done += Math.min(x.size * 0.99, x.lines.filter((t) => t <= until).length * per);
  }
  return done;
}

/**
 * The pull's state at `now` (ms) from the system log's lines, against its image's layers (podImage.imageLayers; null when
 * the registry did not say: then the layers' sizes are not known, and only whether it downloads, extracts or is done is).
 */
export function pullOf(lines: readonly PullLine[], image: readonly ImageLayer[] | null, now: number): PullState {
  const sizes = new Map((image ?? []).map((l) => [l.id, l.size]));
  const { layers, first, end, upToDate } = layersOf(lines, sizes, now);
  const all = [...layers.values()];
  // pulled when any layer came down; the host had it all when the pull ended with nothing downloaded
  const fresh = all.some((x) => !x.had && (x.lines.length > 0 || x.downloaded !== null)) ? true : end !== null && upToDate ? false : null;
  const known = image !== null && all.length > 0 && all.every((x) => x.size !== null);
  const bytes = known ? all.filter((x) => !x.had).reduce((n, x) => n + x.size!, 0) : 0;
  const per = perLine(all);
  const done = known ? doneBy(all, per, now) : 0;
  const lastDownload = all.every((x) => x.had || x.downloaded !== null) && all.length ? Math.max(...all.map((x) => x.downloaded ?? 0)) : null;
  const downloadMs = first !== null && lastDownload !== null ? Math.max(0, lastDownload - first) : null;
  // what extracting added: from its last layer in to the pull's end (the layers before extract while the others come)
  const extractMs = end !== null && lastDownload !== null ? Math.max(0, end - lastDownload) : null;
  if (end !== null) return { phase: "done", fresh, bytes, done: bytes, mbps: downloadMs ? bytes / 1e6 / (downloadMs / 1000) || null : null, leftMs: 0, downloadMs, extractMs };
  if (!all.length) return { phase: "waiting", fresh: null, bytes, done: 0, mbps: null, leftMs: null, downloadMs: null, extractMs: null };
  const downloading = lastDownload === null;
  // its speed over the last minute of its download (all of it, while it is younger), from what the lines say was in by then
  let mbps: number | null = null;
  if (known && first !== null) {
    const to = downloading ? now : lastDownload!;
    const from = Math.max(first, to - WINDOW_MS);
    if (to - from >= 5000) mbps = Math.max(0, doneBy(all, per, to) - doneBy(all, per, from)) / 1e6 / ((to - from) / 1000);
  }
  let leftMs: number | null = null;
  if (known) {
    // its extraction's speed from the big layers this host extracted already, else the usual: a small layer's time is mostly
    // its own start and the log's whole seconds (a 200 MB layer read at 50 MB/s, the 3.7 GB one at 81). The layers extract in
    // their order; of one extracting now, what its time so far took off
    const ex = all.filter((x) => x.extractFrom !== null && x.extracted !== null && x.size !== null && x.size >= BIG_LAYER);
    const exMs = ex.reduce((n, x) => n + (x.extracted! - x.extractFrom!), 0);
    const exRate = exMs >= 5000 ? ex.reduce((n, x) => n + x.size!, 0) / (exMs / 1000) : EXTRACT_RATE;
    const toExtract = all.filter((x) => !x.had && x.extracted === null).reduce((n, x) => n + Math.max(0, x.size! - (x.extractFrom !== null ? ((now - x.extractFrom) / 1000) * exRate : 0)), 0);
    // a host may cap each layer's stream (one read on 2026-10-19: three layers at 78 MB/s together, the big one then alone at
    // 35): the download ends with its slowest layer at its own speed, or with all of it at the speed of the whole
    let slowest = 0;
    for (const x of all) {
      if (x.had || x.downloaded !== null || x.lines.length < 2) continue;
      const from = Math.max(x.lines[0]!, now - WINDOW_MS);
      const seen = x.lines.filter((t) => t >= from).length;
      if (now - from >= 5000 && seen) slowest = Math.max(slowest, Math.max(0, x.size! - x.lines.length * per) / ((seen * per) / ((now - from) / 1000)));
    }
    const downloadLeft = downloading ? (mbps ? Math.max(slowest, (bytes - done) / (mbps * 1e6)) : null) : 0;
    leftMs = downloadLeft === null ? null : Math.round((downloadLeft + toExtract / exRate) * 1000);
  }
  return { phase: downloading ? "downloading" : "extracting", fresh, bytes, done, mbps, leftMs, downloadMs, extractMs };
}

/**
 * The lines kept of a pull for its session's saved boot log (Settings › Rented GPUs › Keep boot logs): every line but the
 * repeats of a layer's "Downloading" / "Extracting", of which one in each 15 s is kept with how many it stands for: a pull
 * says ~1500 lines, ~700 of them for one layer.
 */
export function pullKept(lines: readonly PullLine[]): PullLine[] {
  const out: PullLine[] = [];
  const last = new Map<string, { at: number; skipped: number }>();
  for (const l of lines) {
    const m = /^([0-9a-f]{12}) (Downloading|Extracting)$/.exec(l.line);
    if (!m) {
      out.push(l);
      continue;
    }
    const key = `${m[1]} ${m[2]}`;
    const t = Date.parse(l.ts);
    const seen = last.get(key);
    if (seen && t - seen.at < 15_000) {
      seen.skipped++;
      continue;
    }
    out.push(seen?.skipped ? { ts: l.ts, line: `${l.line} (${seen.skipped + 1} lines since the last)` } : l);
    last.set(key, { at: t, skipped: 0 });
  }
  return out;
}
