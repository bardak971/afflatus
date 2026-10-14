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

export interface VolumeView extends NetworkVolume {
  /** The pod running on it now, when one is: no other pod may use it meanwhile. */
  usedBy: PodOn | null;
  /** Every pod it is mounted on, stopped ones too: it cannot be deleted while one is. */
  mountedOn: PodOn[];
  /** What it costs a month, USD, at RunPod's price for a standard volume. */
  perMonth: number;
}

/** RunPod's price of a standard network volume, USD per GB and month (the first TB). */
export const VOLUME_PER_GB_MONTH = 0.07;
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

export function viewVolumes(volumes: readonly NetworkVolume[], pods: readonly Pod[], machines: readonly Machine[]): VolumeView[] {
  return volumes.map((v) => {
    const on = mountedOn(v.id, pods, machines);
    return { ...v, usedBy: on.find((p) => HOLDS.has(p.status)) ?? null, mountedOn: on, perMonth: Math.round(v.size * VOLUME_PER_GB_MONTH * 100) / 100 };
  });
}

/** What the user is told when a volume is taken: by which pod, and what to do. */
export const inUseSaid = (name: string, by: PodOn) => `The volume "${name}" is in use by ${by.name} (${by.status === "RUNNING" ? "running" : "starting"}): one pod at a time on a volume. Pick another, deploy without one, or stop that pod first.`;
