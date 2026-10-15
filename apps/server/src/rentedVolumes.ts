import { fileKey, volumePerMonth, type PresetFile } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { fileName } from "./media";
import type { Machine } from "./settings";
import type { NetworkVolume, Pod, PodStatus } from "./runpod";

/**
 * RunPod's network volumes as Afflatus shows and guards them (Settings › Rented GPUs, the Deploy dialog): which pod runs on
 * each, and the rule that one running pod at most uses a volume. Afflatus's pod keeps its whole ComfyUI on the volume (the
 * lock, Manager's installs, the models being written): two pods on one would spoil it, so a volume a pod runs on is never
 * offered to another, and one a pod is mounted on (running or stopped) is never deleted under it.
 */

/** A pod on its way up or running: it holds its volume. A stopped one does not (its volume can serve another pod). */
const HOLDS: ReadonlySet<PodStatus> = new Set(["RUNNING", "STARTING", "PROVISIONING"]);

/** A pod named as the user knows it: its machine's name when it is one, else its name on RunPod. */
export interface PodOn {
  pod: string;
  name: string;
  status: PodStatus;
}

/** What a volume holds, as the last pod on it listed: how many model files, when, by which pod. */
export interface Holdings {
  count: number;
  seenAt: string;
  seenBy: string;
}

export interface VolumeView extends NetworkVolume {
  /** What it holds as last seen; null: no pod Afflatus follows ran on it yet. */
  holds: Holdings | null;
  /** When a pod last ran on it (now, while one does); null: never seen used. */
  usedAt: string | null;
  /** No pod ran on it for the days the user set (Settings), or since Afflatus first saw it: it bills for nothing. */
  unused: boolean;
  /** How its last Fill from a set… ended: when, and the files that failed (none: all in). */
  lastFill: FillNote | null;
  /** The pod running on it now, when one is: no other pod may use it meanwhile. */
  usedBy: PodOn | null;
  /** Every pod it is mounted on, stopped ones too: it cannot be deleted while one is. */
  mountedOn: PodOn[];
  /** What it costs a month, USD, at RunPod's price for a standard volume. */
  perMonth: number;
}

/**
 * What storage costs on the account: the volumes (billed every month, pod or not) and the pods' own disks (a stopped pod's
 * still billed). A spending cap stops pods, never storage: only deleting a volume, or terminating a stopped pod, ends it.
 */
export interface Storage {
  /** The volumes' bill this month, as RunPod has written it (a day or so behind); null when RunPod did not give it. */
  volumesMonth: number | null;
  /** Of this month's spending, what the pods' own disks cost (in it already: RunPod bills a pod's disk with its GPU). */
  disksMonth: number;
  /** What storage costs a month with nothing running, as the account stands now: every volume, every pod's own disk at the stopped price (a running one's is in its rate while it runs). */
  perMonth: number;
  volumes: number;
  /** Stopped pods with a disk of their own: billed while they wait. */
  stoppedDisks: number;
  /** The volumes no pod ran on for the days the user set: billed for nothing (Settings › Rented GPUs flags them). */
  unused: Array<{ id: string; name: string; perMonth: number; usedAt: string | null }>;
}

/** The sizes RunPod takes for a volume, GB. */
export const VOLUME_MIN_GB = 10;
export const VOLUME_MAX_GB = 4096;

const podOn = (p: Pod, machines: readonly Machine[]): PodOn => ({ pod: p.id, name: machines.find((m) => m.rented?.pod === p.id)?.name ?? p.name, status: p.status });

/**
 * The pods mounted on a volume, the one running on it first. A pod deployed here a moment ago that RunPod does not list
 * yet (deployed, its ComfyUI not answering yet) counts as starting on it: two deploys in a row never take one volume.
 */
export function mountedOn(volume: string, pods: readonly Pod[], machines: readonly Machine[]): PodOn[] {
  const listed = pods.filter((p) => p.volumeId === volume && p.status !== "TERMINATED").map((p) => podOn(p, machines));
  const unlisted = machines.filter((m) => m.rented?.volume === volume && m.rented.deployedAt && !pods.some((p) => p.id === m.rented!.pod)).map((m) => ({ pod: m.rented!.pod, name: m.name, status: "STARTING" as const }));
  return [...listed, ...unlisted].sort((a, b) => Number(HOLDS.has(b.status)) - Number(HOLDS.has(a.status)));
}

/** The pod running on a volume now, if one is. */
export function usedBy(volume: string, pods: readonly Pod[], machines: readonly Machine[]): PodOn | null {
  return mountedOn(volume, pods, machines).find((p) => HOLDS.has(p.status)) ?? null;
}

export function viewVolumes(volumes: readonly NetworkVolume[], pods: readonly Pod[], machines: readonly Machine[], kept: ReadonlyMap<string, KeptHoldings>, unusedDays: number, now = Date.now()): VolumeView[] {
  return volumes.map((v) => {
    const on = mountedOn(v.id, pods, machines);
    const usedBy = on.find((p) => HOLDS.has(p.status)) ?? null;
    const k = kept.get(v.id);
    const usedAt = usedBy ? new Date(now).toISOString() : k?.usedAt ?? null;
    // never seen used: counted from when Afflatus first saw it (a volume made elsewhere, or before)
    const since = Date.parse(usedAt ?? k?.noticedAt ?? new Date(now).toISOString());
    return {
      ...v, usedBy, mountedOn: on, perMonth: Math.round(volumePerMonth(v.size) * 100) / 100,
      holds: k?.keys && k.seenAt && k.seenBy ? { count: k.keys.size, seenAt: k.seenAt, seenBy: k.seenBy } : null,
      usedAt, unused: !usedBy && unusedDays > 0 && now - since >= unusedDays * 86_400_000, lastFill: k?.fill ?? null,
    };
  });
}

/** How a Fill from a set… ended: when, the files that failed, with why, and why it was cut short when it was (not all in then). */
export interface FillNote {
  at: string;
  failed: Array<{ file: string; error: string }>;
  interrupted?: string;
}

/** What a volume holds as kept: its files' keys (fileKey, by the file's own name; null until listed), when and by which pod, when last used, when first seen. */
export interface KeptHoldings {
  keys: Set<string> | null;
  seenAt: string | null;
  seenBy: string | null;
  usedAt: string | null;
  noticedAt: string;
  fill: FillNote | null;
}

/** Every volume's holdings as kept. */
export async function keptHoldings(db: Db): Promise<Map<string, KeptHoldings>> {
  const rows = await db.selectFrom("volume_files").selectAll().execute();
  return new Map(rows.map((r) => [r.volume_id, { keys: r.files === null ? null : new Set(JSON.parse(r.files) as string[]), seenAt: r.seen_at, seenBy: r.seen_by, usedAt: r.used_at, noticedAt: r.noticed_at, fill: r.fill_note ? (JSON.parse(r.fill_note) as FillNote) : null }]));
}

/** The volumes Afflatus sees for the first time, noted with now: one never used is counted unused from then. */
export async function noticeVolumes(db: Db, volumes: readonly NetworkVolume[], kept: ReadonlyMap<string, KeptHoldings>, now = Date.now()): Promise<void> {
  const fresh = volumes.filter((v) => !kept.has(v.id));
  if (!fresh.length) return;
  const at = new Date(now).toISOString();
  await db.insertInto("volume_files").values(fresh.map((v) => ({ volume_id: v.id, files: null, seen_at: null, seen_by: null, used_at: null, noticed_at: at }))).onConflict((oc) => oc.column("volume_id").doNothing()).execute();
}

/** A file's key as a volume's listing is kept: its folder and its own name (a subfolder on the pod does not count). */
const keyOf = (folder: string, file: string) => fileKey({ folder, file: fileName(file) });

/**
 * What a volume holds, listed through the ComfyUI of the pod running on it, kept with when and by whom. A folder that
 * does not answer keeps what was seen in it before.
 */
export async function recordHoldings(db: Db, volume: string, comfy: Comfy, by: string, folders: readonly string[], now = Date.now()): Promise<void> {
  const before = (await keptHoldings(db)).get(volume);
  const lists = await Promise.all(folders.map(async (folder) => ({ folder, names: await comfy.client.models(folder).catch(() => null) })));
  const keys = new Set<string>();
  for (const { folder, names } of lists) {
    if (names) for (const n of names) keys.add(keyOf(folder, n));
    else for (const k of before?.keys ?? []) if (k.startsWith(`${folder}|`)) keys.add(k);
  }
  const at = new Date(now).toISOString();
  const row = { files: JSON.stringify([...keys].sort()), seen_at: at, seen_by: by, used_at: at };
  await db.insertInto("volume_files").values({ volume_id: volume, ...row, noticed_at: at }).onConflict((oc) => oc.column("volume_id").doUpdateSet(row)).execute();
}

/** How a fill of a volume ended, kept with it (said on its row once its pod is gone): `interrupted` says why it was cut short. */
export async function noteFill(db: Db, volume: string, failed: FillNote["failed"], now = Date.now(), interrupted?: string): Promise<void> {
  const at = new Date(now).toISOString();
  const fill_note = JSON.stringify({ at, failed: failed.slice(0, 50), ...(interrupted ? { interrupted } : {}) });
  await db.insertInto("volume_files").values({ volume_id: volume, files: null, seen_at: null, seen_by: null, used_at: at, noticed_at: at, fill_note }).onConflict((oc) => oc.column("volume_id").doUpdateSet({ fill_note })).execute();
}

/** Of a set's files, those a volume lacks as last seen. */
export const lackingOn = <F extends PresetFile>(files: readonly F[], keys: ReadonlySet<string>): F[] => files.filter((f) => !keys.has(keyOf(f.folder, f.file)));

/** Of a set's files, those a volume lacks as last seen: how many, their bytes as far as known. */
export function missingOn(files: readonly PresetFile[], keys: ReadonlySet<string>): { count: number; bytes: number; unknown: number } {
  const lacking = lackingOn(files, keys);
  return { count: lacking.length, bytes: lacking.reduce((n, f) => n + (f.size ?? 0), 0), unknown: lacking.filter((f) => !f.size).length };
}

/** What the user is told when a volume is taken: by which pod, and what to do. */
export const inUseSaid = (name: string, by: PodOn) => `The volume "${name}" is in use by ${by.name} (${by.status === "RUNNING" ? "running" : "starting"}): one pod at a time on a volume. Pick another, deploy without one, or stop that pod first.`;
