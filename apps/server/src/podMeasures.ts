import { randomUUID } from "node:crypto";
import type { Db } from "./db";

/**
 * What rented pods were measured at (pod_measures): a file's speed from each source, and how long a deploy took to answer.
 * The Deploy dialog says a pod's files' time and price from them, as a range from slow to fast, and nothing at all for a
 * source never measured: a speed is learned on the user's own deploys or not said (this computer's line says nothing of a
 * pod's). A fill's or a volume's plan says a guess for such a source, as a guess (GUESSED).
 */

export type MeasureKind = "hf" | "civitai" | "upload" | "url" | "boot";

/** A file smaller than this says more about the site's answer time than its speed: not kept. */
export const MEASURED_FROM = 100 * 2 ** 20;
/** The last this many of a kind make its range. */
const LAST = 12;

export async function recordMeasure(db: Db, m: { kind: MeasureKind; cloud: string | null; bytes: number; ms: number }, from = MEASURED_FROM): Promise<void> {
  if (m.ms <= 0 || (m.kind !== "boot" && m.bytes < from)) return;
  await db.insertInto("pod_measures").values({ id: randomUUID(), kind: m.kind, cloud: m.cloud, bytes: Math.round(m.bytes), ms: Math.round(m.ms), at: new Date().toISOString() }).execute();
}

/**
 * A model file a pod got, kept whatever its size (pod_fetches): when its bytes came is the Costs tab's "Fetching files" of
 * that pod's session, and its name tells the same file fetched on several deploys (what a network volume would have kept).
 */
export async function recordFetch(db: Db, f: { machine: string; file: string; folder: string; via: string; bytes: number; from: number; to: number }): Promise<void> {
  if (!(f.to > f.from)) return;
  await db.insertInto("pod_fetches").values({ id: randomUUID(), machine_id: f.machine, file: f.file, folder: f.folder, via: f.via, bytes: Math.round(f.bytes), started_at: new Date(f.from).toISOString(), ended_at: new Date(f.to).toISOString() }).execute();
}

export interface Range {
  /** Slowest and fastest of the last measures: bytes a second for a source, ms for a boot. */
  low: number;
  high: number;
  count: number;
}

/**
 * The range a kind was measured in lately, on that cloud when it has measures there, else on any: the slowest and the
 * fastest, without the single most extreme of each end once there are five or more. Null when it was never measured.
 */
export async function measuredRange(db: Db, kind: MeasureKind, cloud: string | null): Promise<Range | null> {
  const read = (onCloud: boolean) => {
    let q = db.selectFrom("pod_measures").select(["bytes", "ms"]).where("kind", "=", kind);
    if (onCloud && cloud) q = q.where("cloud", "=", cloud);
    return q.orderBy("at", "desc").limit(LAST).execute();
  };
  let rows = cloud ? await read(true) : [];
  if (!rows.length) rows = await read(false);
  if (!rows.length) return null;
  const values = rows.map((r) => (kind === "boot" ? r.ms : (r.bytes * 1000) / r.ms)).sort((a, b) => a - b);
  const trimmed = values.length >= 5 ? values.slice(1, -1) : values;
  return { low: trimmed[0]!, high: trimmed[trimmed.length - 1]!, count: rows.length };
}

/**
 * What a kind is taken at before any pod measured it: the usual range, its slow end cautious (a pod's line to Hugging Face
 * and Civitai, this computer's upload; a pod's boot). The queue plans with the slow end; a plan of a fill or a volume says
 * its time from it as a guess, until a pod has fetched one, rather than nothing at all.
 */
export const GUESSED: Record<MeasureKind, Omit<Range, "count">> = {
  hf: { low: 30 * 2 ** 20, high: 100 * 2 ** 20 },
  civitai: { low: 20 * 2 ** 20, high: 60 * 2 ** 20 },
  url: { low: 20 * 2 ** 20, high: 60 * 2 ** 20 },
  upload: { low: 3 * 2 ** 20, high: 10 * 2 ** 20 },
  boot: { low: 60_000, high: 5 * 60_000 },
};

/** The range a kind was measured in (measuredRange), else its guess, said as one. */
export async function rangeOrGuess(db: Db, kind: MeasureKind, cloud: string | null): Promise<Range & { guessed: boolean }> {
  const range = await measuredRange(db, kind, cloud);
  return range ? { ...range, guessed: false } : { ...GUESSED[kind], count: 0, guessed: true };
}

export interface FilesEstimate {
  /** How long the files take, slowest to fastest (ms). */
  fastMs: number;
  slowMs: number;
  /** What that time costs at the pod's rate, slowest to fastest ($). */
  lowUsd: number;
  highUsd: number;
  /** A source of these files was never measured: its share is the guess (GUESSED), said as such. */
  guessed: boolean;
}

/**
 * How long a pod's files take and what that costs at `rate` ($/h): each source's files at its measured speeds, the sources
 * one after another (a pod takes two files at a time, which share its line). A source never measured is taken at its
 * guess and the estimate says so: a set holding one file of a source never fetched said nothing at all for the whole set.
 */
export async function estimateFiles(db: Db, files: Array<{ bytes: number; kind: Exclude<MeasureKind, "boot"> }>, cloud: string | null, rate: number): Promise<FilesEstimate> {
  let fastMs = 0;
  let slowMs = 0;
  let guessed = false;
  const kinds = [...new Set(files.filter((f) => f.bytes > 0).map((f) => f.kind))];
  for (const kind of kinds) {
    const range = await rangeOrGuess(db, kind, cloud);
    guessed ||= range.guessed;
    const bytes = files.filter((f) => f.kind === kind).reduce((n, f) => n + f.bytes, 0);
    fastMs += (bytes / range.high) * 1000;
    slowMs += (bytes / range.low) * 1000;
  }
  const usd = (ms: number) => (ms / 3_600_000) * rate;
  return { fastMs, slowMs, lowUsd: usd(fastMs), highUsd: usd(slowMs), guessed };
}
