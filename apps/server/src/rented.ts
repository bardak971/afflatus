import { httpError } from "./errors";
import { COMFY_PORT, HOURS_A_MONTH, RUNNING_DISK_PER_GB_MONTH, STOPPED_DISK_PER_GB_MONTH, type GpuOffer } from "./runpod";
import { shortGpu, stepSaid, volumePerMonth, type PresetFile } from "@afflatus/core";
import { bootOf } from "./podBoot";
import { buildOf } from "./podImage";
import { dollars } from "./notifyWords";
import { forgetSetAside, machinesSetAside, readSettings, updateSettings, type Machine } from "./settings";
import { CAP_REACHED } from "./queueModel";
import type { RentedView, Seen } from "./rentedModel";
import { capReached, HOUR } from "./rentedBilling";
import { BILLED, bootLimit, secretOf, TRANSITIONAL } from "./rentedFollow";
import { ownPorts, RentedDeploy } from "./rentedDeploy";

/**
 * Rented machines: pods the user made on RunPod and added to Afflatus as machines. Afflatus never starts one on its own:
 * Start is the user's. It reads each pod's state from RunPod (so a pod running while Afflatus restarts is picked up again),
 * keeps when each ran and at what rate (rent_sessions: today's and this month's cost, the caps), stops one that sat idle
 * (nothing rendering there, nothing waiting it could take) or that reached a cap once its render ends, and says "still
 * here" to the node pack's watchdog on it, which stops the pod by itself when this PC goes silent.
 *
 * Each pod is handled on its own: one that RunPod refuses something for says so on its card, and the others go on being
 * watched. A pod being stopped takes no new work from the moment Afflatus decides to stop it. A read of RunPod older than
 * an action of the user's (Start, Stop) is not taken over it.
 */

/** From then a deployed pod's first start is said as slow on its card (before, as a normal step). */
const DEPLOY_SLOW_MS = 12 * 60_000;

/** After this long running without an answer, its card says so (it is billed meanwhile). */
const BOOT_SLOW_MS = 2 * 60_000;
/** How long a token's start_pod waits for a pod being stopped here to say so on RunPod, before refusing it as up. */
const STOPPING_WAIT_MS = 30_000;

/** How long a network volume's size, as RunPod says it, is kept before it is asked again (a volume is grown seldom). */
const VOLUME_SIZE_MS = 10 * 60_000;

/** What Deploy on its volume would deploy in place of a stopped pod whose Start RunPod refused (Rented.redeployOffer). */
export interface RedeployOffer {
  /** The stopped pod's name, as its card says it; and its GPU, by name. */
  name: string;
  was: string;
  /** The GPU offered: its own when one is free where its volume is (`same`), else the cheapest free there with as much memory. */
  gpu: { id: string; name: string; price: number };
  same: boolean;
  /** Its GPU's memory was known (RunPod lists that GPU now): the one offered has as much; else it is the cheapest free there. */
  sized: boolean;
  cloud: "SECURE" | "COMMUNITY";
  template: "afflatus" | "runpod";
  /** The Afflatus image's build: its own, or 12.8 on a GPU whose hosts lack CUDA 13 (`cudaChanged`); null for RunPod's image. */
  cuda: "13.0" | "12.8" | null;
  cudaChanged: boolean;
  dataCenter: string | null;
  /** Its network volume, which the new pod mounts; null: none, its files are fetched again (`refetch`, as far as known). */
  volume: { id: string; name: string } | null;
  refetch: { files: number; bytes: number } | null;
  /** Its container disk (GB), and the rate while it runs: the GPU and that disk, as RunPod bills them. */
  disk: number;
  rate: number;
  idleMinutes: number;
  idleDo: "stop" | "terminate";
  watchdogMinutes: number;
}

/** What its card says of a pod whose ComfyUI died: why, as the pod or the queue said it, and where its last lines are. */
const diedSaid = (s: Seen): string =>
  `${s.stoppedBy === "crash" ? "Terminated: " : ""}${s.comfyDied!.said}.${s.comfyDied!.render ? " Its render failed, not run again." : ""}${s.comfyDied!.from === "pod" ? " ComfyUI's last lines are in its log (Queue › Log)." : ""}`;

export class Rented extends RentedDeploy {
  /**
   * Whether a machine can take work: a rented one only while its pod runs and is not being stopped, never one filling its
   * volume, and none at a spending cap: the render it runs ends, then it stops, and a job started meanwhile (the queue
   * starts the next one as soon as a render ends, before the next read) would be billed past the cap; nor one added by hand
   * whose ComfyUI is hung in a render failed as stuck (Seen.hung). Null: it can.
   */
  unavailable(machine: string): string | null {
    if (this.filling.has(machine)) return "filling its volume";
    return this.podDown(machine) ?? (this.seen.get(machine)?.stopAfter ? CAP_REACHED : null) ?? this.seen.get(machine)?.hung ?? null;
  }

  /**
   * Whether a machine's pod is down for good as far as its container goes: stopped, failed or terminated, or not on RunPod
   * at two reads in a row (one answer of RunPod's can come back without it). Not while it is being stopped: that may fail.
   */
  podGone(machine: string): boolean {
    const s = this.seen.get(machine);
    if (!s) return false;
    if (s.pod) return s.pod.status === "EXITED" || s.pod.status === "ERROR" || s.pod.status === "TERMINATED";
    return s.missing >= 2;
  }

  /** The network volume RunPod last said its pod is on: a pod added by hand names none in its settings. Null: none, or not read. */
  volumeOf(machine: string): string | null {
    return this.seen.get(machine)?.pod?.volumeId ?? null;
  }

  /** Each network volume's size as RunPod last said it (GB), and when: read again every VOLUME_SIZE_MS at most. */
  private readonly volumeSizes = new Map<string, { gb: number; at: number }>();

  /**
   * The bytes of the network volume a machine's pod runs on, as RunPod sizes it: its node pack reads the volume's disk as
   * RunPod's whole shared storage (1663254.3/2190892.5 GB on its card, card #149). Null: on none, or RunPod not read.
   */
  async volumeBytes(machine: string): Promise<number | null> {
    const s = await readSettings(this.db);
    const volume = this.volumeOf(machine) ?? s.machines.find((m) => m.id === machine)?.rented?.volume ?? null;
    if (!volume || !s.runpodKey) return null;
    let kept = this.volumeSizes.get(volume);
    if (!kept || this.now() - kept.at > VOLUME_SIZE_MS) {
      const volumes = await this.client(s.runpodKey).volumes().catch(() => null);
      for (const v of volumes ?? []) if (v.size > 0) this.volumeSizes.set(v.id, { gb: v.size, at: this.now() });
      kept = this.volumeSizes.get(volume);
    }
    return kept ? kept.gb * 2 ** 30 : null;
  }

  /** Whether a machine's pod is down: not running, or being stopped. Null: up (or not a rented machine). Its files follow this. */
  podDown(machine: string): string | null {
    const s = this.seen.get(machine);
    if (!s) return null;
    if (s.stopping) return "being stopped";
    // not read from RunPod yet (Afflatus just started): down until a read says it runs, never said gone
    if (!s.read) return "not read from RunPod yet";
    const status = s.pod?.status ?? "GONE";
    return status === "RUNNING" ? null : status === "GONE" ? "not on RunPod" : status === "EXITED" ? "stopped" : status.toLowerCase();
  }

  /** What is said of a rented machine; null for a ComfyUI of its own. */
  view(machine: Machine): RentedView | null {
    if (!machine.rented) return null;
    const s = this.seen.get(machine.id);
    const pod = s?.pod ?? null;
    // GONE only once RunPod was read without it: before the first read (Afflatus just restarted, a pod running all along)
    // its state is not known, and a running pod said gone for a few seconds read as one lost
    const status: RentedView["status"] = s?.read ? (pod ? pod.status : "GONE") : "UNKNOWN";
    // from its open session's start, never RunPod's startedAt: right after a Start, RunPod may still say the run before's,
    // and the card would count the hours it was stopped as spent (session() keeps the guard against that)
    const since = pod?.status === "RUNNING" ? s?.sessionFrom ?? null : null;
    const rate = s?.rate ?? (pod?.cost || null);
    const idleMs = machine.rented.idleMinutes * 60_000;
    const booting = Boolean(machine.rented.deployedAt) && (status === "RUNNING" || (TRANSITIONAL.has(status) && status !== "UNKNOWN")) && !s?.answered;
    const deployedAt = Date.parse(machine.rented.deployedAt);
    const boot = booting ? bootOf(pod, this.boots.get(machine.id), Number.isFinite(deployedAt) ? deployedAt : this.now()) : null;
    // how far its pull is, while it pulls and its system log was read (rentedFollow readPull)
    const pull = s?.pull;
    if (boot?.phase === "pulling" && pull && pull.phase !== "done") boot.pull = { stage: pull.phase, done: pull.done, bytes: pull.bytes, mbps: pull.mbps, leftMs: pull.leftMs };
    // its image in, by its log, before RunPod says its container's uptime: its container is starting
    if (boot?.phase === "pulling" && pull?.phase === "done") boot.phase = "starting";
    return {
      provider: "runpod", pod: machine.rented.pod, status, rate, gpuRate: pod?.gpuCost || null, gpu: pod?.gpu ?? null, dataCenter: pod?.dataCenter ?? null,
      // the build from the image it was deployed with, else as RunPod names it (a pod added by hand)
      cuda: buildOf(machine.rented.image || pod?.image), hostCuda: pod?.hostCuda ?? null,
      since, spent: since && rate ? ((this.now() - since) / HOUR) * rate : 0,
      diskPerDay: pod ? (pod.diskGb * STOPPED_DISK_PER_GB_MONTH * 24) / HOURS_A_MONTH : 0,
      volume: Boolean(pod && (pod.networkVolume || pod.diskGb > 0)),
      otherPorts: pod ? pod.ports.filter((p) => !ownPorts(machine).includes(p)) : [],
      closedPorts: machine.rented.closedPorts,
      watchdog: status === "RUNNING" ? s?.watchdog ?? "unknown" : "unknown",
      answers: status === "RUNNING" ? s?.answers ?? null : null,
      // none while files come to it: its idle time is held then, and a countdown would read as a stop to come
      // none before its first answer either (a boot): its idle time counts only from then (keepOrStop), its boot is said instead
      // none while its ComfyUI runs work from outside Afflatus: that holds its idle time too
      idleLeftMs: status === "RUNNING" && !s?.stopping && (s?.answered || s?.busyRestored) && idleMs > 0 && s?.busyAt && !this.queue.busyOn(machine.id) && !this.queue.fetching(machine.id) ? Math.max(0, idleMs - (this.now() - s.busyAt)) : null,
      capped: s?.stopAfter ?? false,
      stopping: s?.stopping ?? false,
      stoppedBy: s?.stoppedBy ?? null,
      crash: s?.comfyDied && (s.stoppedBy === "crash" || s.answers === false) ? s.comfyDied.said : null,
      booting,
      boot,
      // a start that stopped on an error says so as its pod says it, before the boot limit's words
      error: s?.error ?? this.error ?? s?.hung ?? s?.bootNote ?? (s?.stoppedBy === "gpu" ? s.gpuFailed : null) ?? (s?.stoppedBy === "start" ? s.startFailed : null) ?? (s?.comfyDied && (s.stoppedBy === "crash" || s.answers === false) ? diedSaid(s) : null) ?? (boot?.failed && boot.step ? `Start failed: ${stepSaid(boot.step)}. Terminated now, nothing billed after; its last lines are in its log (Queue › Log).` : null) ?? this.unanswered(machine, s ?? null, status, bootLimit(machine)),
    };
  }

  /** What its card says of a pod RunPod has running that nothing answers on: its container may not have started. */
  private unanswered(m: Machine, s: Seen | null, status: RentedView["status"], limit: number): string | null {
    if (status !== "RUNNING" || !s?.upAt || s.answered) return null;
    // a deployed pod's first start (its image pulled onto the host, then ComfyUI): a normal step for some minutes, said
    // as one on its card; only one that drags is said here
    const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
    if (Number.isFinite(deployedAt)) {
      const minutes = Math.round((this.now() - deployedAt) / 60_000);
      return this.now() - deployedAt < DEPLOY_SLOW_MS ? null : `Its first start is taking long: nothing answers on ${COMFY_PORT} after ${minutes} min (an image pull this slow, or a container that does not start: its logs on RunPod). Billed meanwhile; terminated at ${limit / 60_000} min if it is not up.`;
    }
    if (this.now() - s.upAt < BOOT_SLOW_MS) return null;
    return `RunPod says it is running, but nothing answers on ${COMFY_PORT} after ${Math.round((this.now() - s.upAt) / 60_000)} min: its image may still be pulling, or its container did not start (look at its logs on RunPod). It is billed meanwhile; with no answer by ${limit / 60_000} min, its idle action applies.`;
  }

  /**
   * A machine removed from Afflatus by the user (its card's Remove). A rented pod is left as it is on RunPod, running or not:
   * its secret stays while the pod does (it reads it at its start), and goes once the pod is gone (sweepSecrets).
   */
  async remove(machine: string): Promise<void> {
    // a pod still running (or starting) is billed with nothing here to stop it once it is out of Afflatus: stopped first
    const settings = await readSettings(this.db);
    const rented = settings.machines.find((x) => x.id === machine)?.rented;
    const status = rented ? await this.statusForRemove(machine, rented.pod, settings.runpodKey) : null;
    if (status && BILLED.has(status)) throw httpError("It is running on RunPod, billed: stop or terminate it first, then remove it.", 409);
    let found = false;
    await updateSettings(this.db, (current) => {
      const m = current.machines.find((x) => x.id === machine);
      if (!m) return null;
      found = true;
      if (current.machines.length < 2) throw httpError("at least one ComfyUI is needed", 409);
      return {
        machines: current.machines.filter((x) => x.id !== machine),
        ...(m.rented ? { leftSecrets: [...current.leftSecrets.filter((l) => l.pod !== m.rented!.pod), { secret: secretOf(m), pod: m.rented.pod }] } : {}),
      };
    });
    if (!found) throw httpError("there is no ComfyUI with that id", 404);
    this.seen.delete(machine);
    this.events.emit("setup");
  }

  /**
   * A stored machine set aside whole (settings.ts load) forgotten on the user's word, by its key (its note's Forget). One with
   * a pod is forgotten only once RunPod says that pod no longer bills, or when the user says so (`anyway`) after being told:
   * once its row is gone, nothing here stops it any more.
   */
  async forgetSetAside(key: string, anyway: boolean): Promise<void> {
    const settings = await readSettings(this.db);
    const a = machinesSetAside(settings).find((x) => !x.mended && x.key === key);
    if (!a) throw httpError("That entry is no longer stored.", 404);
    if (a.pod && !anyway) {
      const unknown = `Whether its pod ${a.pod} still runs on RunPod is not known`;
      if (!settings.runpodKey) throw httpError(`${unknown} (no RunPod API key). Forgotten, it is no longer stopped from here if it runs.`, 409);
      let status: string | null;
      try {
        status = (await this.client(settings.runpodKey).pod(a.pod))?.status ?? null;
      } catch (err) {
        throw httpError(`${unknown} (${(err as Error).message}). Forgotten, it is no longer stopped from here if it runs.`, 409);
      }
      if (status && BILLED.has(status)) throw httpError(`Its pod ${a.pod} still runs on RunPod, billed. Forgotten, nothing here stops it any more: stop or terminate it on RunPod.`, 409);
    }
    if (!(await forgetSetAside(this.db, key))) throw httpError("That entry is no longer stored.", 404);
    this.events.emit("setup");
  }

  /**
   * A pod's status before its machine is removed: as last read when that is known, read from RunPod now when it is not
   * (Afflatus just started, RunPod's last read failed, or a read had it missing once). Refused when RunPod cannot say: a pod
   * running unseen would bill with nothing following it, and one from RunPod's own image has no watchdog to stop it.
   */
  private async statusForRemove(machine: string, pod: string, key: string): Promise<string | null> {
    const s = this.seen.get(machine);
    if (s?.read && this.error === null && (s.pod !== null || s.missing >= 2)) return s.pod?.status ?? null;
    const unknown = "Its state on RunPod is not known yet";
    if (!key) throw httpError(`${unknown} (no RunPod API key): set the key in Settings › Rented GPUs, or stop it on RunPod, then remove it.`, 409);
    try {
      return (await this.client(key).pod(pod))?.status ?? null;
    } catch (err) {
      throw httpError(`${unknown} (${(err as Error).message}): remove it once RunPod answers, or stop it on RunPod first.`, 409);
    }
  }

  /**
   * Whether a machine is a pod deployed for renders that has not answered yet (its first start), and is not down for good:
   * one just made and not listed by RunPod yet counts, as it does for its volume (rentedVolumes.ts). The GPU hunt deploys
   * nothing while one is: it is coming for the renders that wait.
   */
  firstStarting(m: Machine): boolean {
    if (!m.rented?.deployedAt || m.rented.fill) return false;
    const s = this.seen.get(m.id);
    if (s?.answered || s?.stopping || s?.stoppedBy) return false;
    return !s?.pod || BILLED.has(s.pod.status);
  }

  /** A deploy under way (the user's, a fill's or the GPU hunt's): another is refused until it ends. */
  get busy(): boolean {
    return this.deploying;
  }

  /**
   * The user's Start: refused at a cap. `mcpToken`: the MCP token whose start_pod asked for it, whose spend this run is
   * (rentedSchema.mcpToken); the user's own Start makes the run theirs again.
   */
  async start(machine: string, mcpToken = ""): Promise<RentedView> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    if (capReached(s.rentCaps, await this.spent())) {
      throw httpError("A spending cap is reached: raise it in Settings › Rented GPUs to start it.", 409);
    }
    // one running pod per volume, as for a deploy: a stopped pod's volume may have gone to another pod meanwhile
    if (s.runpodKey) await this.volumeFree(m, s);
    // a token's start_pod starts a stopped pod, never claims one already up: written as the token's, the user's pod (or
    // another token's) would be steered onto, spared its idle tail and stopped at this token's cap (card #182)
    if (mcpToken) await this.mustBeStopped(m, s.runpodKey);
    const unprepared = await this.prepareBoot(m, s.runpodKey);
    // whose run this is, written before RunPod is asked: its session is opened from it at the first read of it running;
    // put back when RunPod refuses the start, or a pod left stopped would stay the token's
    const was = m.rented.mcpToken;
    const owner = (mcpToken: string) => updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, mcpToken } } : x)) }));
    if (was !== mcpToken) await owner(mcpToken);
    // stopped during its first boot: still a first boot (its deploy's files handed at its first answer), its deadline from
    // this Start, never from its deploy hours ago (terminated at its first read as a boot that never came up)
    if (m.rented.deployedAt) {
      const at = new Date(this.now()).toISOString();
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented?.deployedAt ? { ...x, rented: { ...x.rented, deployedAt: at } } : x)) }));
    }
    await this.act(m, "start", null).catch(async (err: Error & { statusCode?: number }) => {
      if (was !== mcpToken) await owner(was);
      // its GPU was taken while it was stopped: a stopped pod is bound to its host, and RunPod has none free there. Every
      // Start of the 0.8.1 re-check met this (7 of 7, one 2 min after its stop): the page offers Deploy on its volume
      // (redeployOffer), which `redeploy` marks
      if (/not enough free gpus|no longer available|no gpus? (are )?available|insufficient (gpu )?capacity/i.test(err.message)) {
        throw Object.assign(httpError("Start refused: its GPU was taken while it was stopped (no free GPU on its host). Deploy a new pod on its volume, or Start again later.", 409), { redeploy: true });
      }
      throw err;
    });
    // said on its card for the run: it may run open until it is up and locked
    this.seenOf(m.id).bootNote = unprepared;
    return this.view(m)!;
  }

  /**
   * Refused unless RunPod says the pod is stopped (or failed): what this app last saw is not enough, a pod started on
   * RunPod's site since is up. One stopping a moment ago gets prepareBoot's wait first.
   */
  private async mustBeStopped(m: Machine, key: string): Promise<void> {
    if (!key) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(key);
    let pod = await client.pod(m.rented!.pod).catch((err: Error) => {
      throw httpError(`RunPod did not say whether ${m.name || m.id} is stopped (${err.message}): not started.`, 502);
    });
    for (const ends = this.now() + STOPPING_WAIT_MS; pod && this.seen.get(m.id)?.stopping && BILLED.has(pod.status) && this.now() < ends; ) {
      await new Promise((r) => setTimeout(r, this.settleEveryMs));
      pod = await client.pod(m.rented!.pod).catch(() => pod);
    }
    if (pod && BILLED.has(pod.status)) throw httpError(`${m.name || m.id} is already ${pod.status.toLowerCase()} on RunPod: start_pod starts a stopped pod. Its run stays whoever's it is; this token's own work goes there by run_on or use_only, counted.`, 409);
  }

  /**
   * What Deploy on its volume would make in place of a stopped pod RunPod will not start (its host has no GPU free): a new
   * pod of its GPU where its network volume is (its models are there), else the cheapest one free there with at least its
   * GPU's memory (one with less may not run what it ran), said as another; with its idle stop, watchdog, image build, cloud
   * and set. A pod with no network volume gets a new one anywhere, its files fetched again. Read-only: nothing is made.
   */
  async redeployOffer(machine: string): Promise<RedeployOffer> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const [pod, volumes] = await Promise.all([client.pod(m.rented.pod), client.volumes()]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    if (!pod) throw httpError("That pod is not on RunPod any more: deploy a new one (Deploy a GPU).", 409);
    if (pod.status !== "EXITED" && pod.status !== "ERROR") throw httpError("That pod is not stopped: it needs no other.", 409);
    const cloud = m.rented.cloud ?? "SECURE";
    const offers = await this.gpus(cloud);
    const volumeId = pod.volumeId || m.rented.volume;
    const volume = volumeId ? volumes.find((v) => v.id === volumeId) ?? null : null;
    if (volumeId && !volume) throw httpError("Its network volume is not on this account any more: deploy a new pod (Deploy a GPU).", 409);
    const free = (g: GpuOffer) => (volume ? g.dataCenters.some((d) => d.id === volume.dataCenter && d.availability !== "NONE") : g.availability !== "NONE");
    const was = offers.find((g) => g.id === pod.gpu) ?? null;
    const gpu = (was && free(was) ? was : null) ?? offers.filter((g) => free(g) && (!was || g.memory >= was.memory)).sort((a, b) => a.price - b.price)[0];
    const wasName = was?.name ?? (pod.gpu ? shortGpu(pod.gpu) : "its GPU");
    if (!gpu) throw httpError(volume ? `No ${wasName} or larger GPU is free in ${volume.dataCenter}, where its volume "${volume.name}" is: Start again later.` : `No ${wasName} or larger GPU is free now: Start again later.`, 409);
    // with a volume its container disk is 40 GB at most, as any deploy (rentedDeploy deployNow)
    const disk = Math.max(20, volume ? Math.min(pod.containerGb || 40, 40) : pod.containerGb || 120);
    // its own CUDA build where that GPU's hosts have it; the Afflatus image's 13.0 build on a GPU without, 12.8 for this once
    // (said in the confirm): an image not Afflatus's has one build
    const image = m.rented.image || pod.image || "";
    const build = buildOf(image);
    const cuda = build === "13.0" && !gpu.cuda13 ? "12.8" : build;
    const refetch = volume ? null : { files: m.rented.setFiles.length, bytes: m.rented.setFiles.reduce((n, f) => n + (f.size ?? 0), 0) };
    return {
      name: m.name || pod.name, was: wasName, gpu: { id: gpu.id, name: gpu.name, price: gpu.price }, same: gpu.id === was?.id, sized: Boolean(was), cloud, template: image && !build ? "runpod" : "afflatus", cuda, cudaChanged: cuda !== build, dataCenter: volume?.dataCenter ?? null,
      volume: volume ? { id: volume.id, name: volume.name } : null, disk, rate: gpu.price + (disk * RUNNING_DISK_PER_GB_MONTH) / HOURS_A_MONTH, refetch,
      idleMinutes: m.rented.idleMinutes, idleDo: volume ? m.rented.idleDo : "terminate", watchdogMinutes: m.rented.watchdogMinutes,
    };
  }

  /**
   * Deploy on its volume, on the user's click after its confirm (the rate, its idle stop): a new pod of the GPU offered
   * (redeployOffer), through the one deploy path, so refused at a spending cap as any. `files`: the ones its set brings
   * (rented-api.ts). The stopped pod is left as it is. Answers the new machine's id.
   */
  async redeploy(machine: string, gpu: string, files: PresetFile[]): Promise<{ id: string; dataCenter: string | null }> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    const offer = await this.redeployOffer(machine);
    // the GPU the confirm said, or what is free now said again: never another the user did not see
    if (offer.gpu.id !== gpu) throw httpError(`${offer.gpu.name} is the one free there now, not the GPU you confirmed: ask again.`, 409);
    return this.deploy({
      gpu, cloud: offer.cloud, template: offer.template, volume: offer.volume?.id ?? "", disk: offer.disk,
      idleMinutes: offer.idleMinutes, idleDo: offer.idleDo, watchdogMinutes: offer.watchdogMinutes, set: m.rented.set, files, leaveOut: [], accept: [], again: false,
      // the build offered, for this once: the CUDA pick remembered for the next deploy stays as it was
      makeRoom: m.rented.makeRoom, cuda: offer.cuda ?? "either", cudaOnce: true,
    });
  }

  /** The user's Stop, or Terminate: then the machine goes from Afflatus too (nothing is left to do with it), and its secret. */
  async stopBy(machine: string, how: "stop" | "terminate"): Promise<RentedView | null> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    await this.act(m, how, "you");
    if (how !== "terminate") return this.view(m)!;
    await this.forget(m, this.seenOf(m.id));
    return null;
  }

  /**
   * What going back to a version without rented GPUs (0.4.0) leaves on RunPod, read from RunPod now: this Afflatus's pods
   * that run (or start), which it would bill with no screen, no idle stop and no cap; and what keeps billing stopped, each
   * with what it costs a month (its pods' disks, the account's network volumes). RunPod not answering: the pods as last
   * read, the storage not known (`unknown`), and why the pods could not be read (`unreadable`: Go back is refused then, as
   * whether one runs is not known).
   * Back to a version with rented GPUs, `known` is what the library restored knows (its copy taken at the update): only this
   * Afflatus's pods that copy has no machine for are said, as that version would not follow them (no idle stop, no cap, no
   * pings); its volumes it sees itself, and they are not said.
   */
  async goingBack(known?: ReadonlySet<string>): Promise<{ running: string[]; billing: string[]; unknown: boolean; unreadable: string | null }> {
    const s = await readSettings(this.db);
    const mine = s.machines.filter((m) => m.rented && !known?.has(m.rented.pod));
    if (!s.runpodKey || !mine.length) return { running: [], billing: [], unknown: false, unreadable: null };
    const client = this.client(s.runpodKey);
    let unreadable: string | null = null;
    const [pods, volumes] = await Promise.all([client.pods().catch((err: Error) => ((unreadable = err.message), null)), client.volumes().catch(() => null)]);
    const podOf = (m: Machine) => (pods ? pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null : this.seen.get(m.id)?.pod ?? null);
    const running = mine.flatMap((m) => {
      const pod = podOf(m);
      return pod && pod.status !== "EXITED" ? [`${m.name || pod.name}${pod.gpu ? ` (${pod.gpu})` : ""}`] : [];
    });
    const disks = mine.flatMap((m) => {
      const pod = podOf(m);
      return pod?.status === "EXITED" && pod.diskGb > 0 ? [`${m.name || pod.name}, stopped: its ${pod.diskGb} GB disk, ${dollars(pod.diskGb * STOPPED_DISK_PER_GB_MONTH)}/month`] : [];
    });
    const kept = known ? [] : (volumes ?? []).map((v) => `volume ${v.name} (${v.size} GB, ${dollars(volumePerMonth(v.size))}/month)`);
    return { running, billing: [...disks, ...kept], unknown: !pods || (!known && !volumes), unreadable };
  }
}
