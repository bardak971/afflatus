import { randomUUID } from "node:crypto";
import type { Db } from "./db";

/**
 * What rented pods were measured at (pod_measures): a file's speed from each source, and how long a deploy took to answer.
 * The Deploy dialog says a pod's files' time and price from them, as a range from slow to fast, and nothing at all for a
 * source never measured: a speed is learned on the user's own deploys or not said (this computer's line says nothing of a
 * pod's).
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

export interface FilesEstimate {
  /** How long the files take, slowest to fastest (ms). */
  fastMs: number;
  slowMs: number;
  /** What that time costs at the pod's rate, slowest to fastest ($). */
  lowUsd: number;
  highUsd: number;
}

/**
 * How long a pod's files take and what that costs at `rate` ($/h): each source's files at its measured speeds, the sources
 * one after another (a pod takes two files at a time, which share its line). Null when a source of these files was never
 * measured: then nothing is said.
 */
export async function estimateFiles(db: Db, files: Array<{ bytes: number; kind: Exclude<MeasureKind, "boot"> }>, cloud: string | null, rate: number): Promise<FilesEstimate | null> {
  let fastMs = 0;
  let slowMs = 0;
  const kinds = [...new Set(files.filter((f) => f.bytes > 0).map((f) => f.kind))];
  for (const kind of kinds) {
    const range = await measuredRange(db, kind, cloud);
    if (!range) return null;
    const bytes = files.filter((f) => f.kind === kind).reduce((n, f) => n + f.bytes, 0);
    fastMs += (bytes / range.high) * 1000;
    slowMs += (bytes / range.low) * 1000;
  }
  const usd = (ms: number) => (ms / 3_600_000) * rate;
  return { fastMs, slowMs, lowUsd: usd(fastMs), highUsd: usd(slowMs) };
}
