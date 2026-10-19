import { randomUUID } from "node:crypto";
import { httpError } from "./errors";
import { newToken } from "./lock-api";
import { BOOT_PORT, COMFY_PORT, exposesComfy, imageFor, LOCK_ENV, noCapacity, POD_IMAGES, podMachineId, podUrl, RunpodError, RunpodShape, secretRef, WATCHDOG_ACTION_ENV, WATCHDOG_ENV, type GpuOffer, type NetworkVolume, type Pod, type PodSpec } from "./runpod";
import type { PresetFile } from "@afflatus/core";
import { imagePublic } from "./podImage";
import { inUseSaid, keptHoldings, noticeVolumes, mountedOn, usedBy, viewVolumes, VOLUME_MAX_GB, VOLUME_MIN_GB, type VolumeView } from "./rentedVolumes";
import { MAX_MACHINES, readSettings, updateSettings, type DeployAsk, type Machine, type Settings } from "./settings";
import { RentedFollow, secretOf } from "./rentedFollow";

/** The freest data center first, for a deploy. */
const FREEST = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 } as const;

/**
 * The ports of a pod that are Afflatus's own, behind its token: ComfyUI's, and on a pod deployed from Afflatus its boot log's
 * (deploy/runpod/bootlog.py). Any other is outside the lock: said on its card, closed at a Start unless kept open.
 */
export const ownPorts = (m: Machine) => [`${COMFY_PORT}/http`, ...(m.rented?.deployed ? [`${BOOT_PORT}/http`] : [])];

/** How long a Start waits for a pod just stopped to be stopped on RunPod's side before preparing it. */
const SETTLE_MS = 30_000;

/**
 * Why a deploy was refused, for the GPU hunt (hunt.ts), which goes on hunting or gives up by it: no GPU free any more where
 * asked, another deploy under way, the volume used by another pod, a spending cap, RunPod's balance too low.
 */
export type DeployRefusal = "noGpu" | "busy" | "volumeBusy" | "cap" | "balance";
const refused = (message: string, why: DeployRefusal): Error => Object.assign(httpError(message, 409), { refusal: why });
/** The refusal a deploy's error carries; null for any other error. */
export const refusalOf = (err: unknown): DeployRefusal | null => (err as { refusal?: DeployRefusal } | null)?.refusal ?? null;

/**
 * Deploys and network volumes (rented.ts): the GPUs RunPod offers, a pod made with Afflatus's image (a fill pod among
 * them), the volumes made, grown and deleted, and a start's preparation.
 */
export class RentedDeploy extends RentedFollow {
  /** How long a deploy whose answer was lost waits before it looks again for the pod RunPod may have made (shorter in tests). */
  lookAgainMs = 8_000;
  /** How often a Start asks RunPod whether a pod just stopped is stopped yet. */
  settleEveryMs = 2_000;

  /** The GPUs a pod can be deployed on now, on that cloud (Deploy a GPU). */
  async gpus(cloud: PodSpec["cloud"]): Promise<GpuOffer[]> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    return this.client(s.runpodKey).gpus(cloud).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
  }

  /** The account's network volumes (Deploy a GPU, Settings): each with the pod running on it, when one is. */
  async volumes(): Promise<VolumeView[]> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const [volumes, pods] = await Promise.all([client.volumes(), client.pods()]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const kept = await keptHoldings(this.db);
    await noticeVolumes(this.db, volumes, kept, this.now());
    return viewVolumes(volumes, pods, s.machines, kept, s.volumeUnusedDays, this.now());
  }

  /** A network volume made, as the user asked (its monthly price said before): billed every month from now, pod or not. */
  async makeVolume(name: string, size: number, dataCenter: string): Promise<NetworkVolume> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    if (!Number.isInteger(size) || size < VOLUME_MIN_GB || size > VOLUME_MAX_GB) throw httpError(`A volume is ${VOLUME_MIN_GB} to ${VOLUME_MAX_GB} GB.`);
    await this.monthCapped();
    const made = await this.client(s.runpodKey).createVolume(name, size, dataCenter).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    console.log(`[rented] volume ${made.name} made in ${made.dataCenter}, ${made.size} GB`);
    this.storageSeen = null;
    this.events.emit("setup");
    return made;
  }

  /** The data centers that take a network volume; null when RunPod does not say (Make a volume then offers every place). */
  async volumeDataCenters(): Promise<string[] | null> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) return null;
    return this.client(s.runpodKey).volumeDataCenters().catch(() => null);
  }

  /** A network volume made larger: RunPod never makes one smaller. */
  async growVolume(id: string, size: number): Promise<void> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const volume = (await client.volumes().catch((err: Error) => {
      throw httpError(err.message, 502);
    })).find((v) => v.id === id);
    if (!volume) throw httpError("That network volume is not on this account any more.", 404);
    if (!Number.isInteger(size) || size <= volume.size || size > VOLUME_MAX_GB) throw httpError(`A volume only grows: more than ${volume.size} GB, ${VOLUME_MAX_GB} at most.`);
    await this.monthCapped();
    await client.growVolume(id, size).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    // what storage costs a month moved with it: said at once, not at the next read
    this.storageSeen = null;
    this.events.emit("setup");
  }

  /** A network volume deleted with all it holds (its billing ends): never while a pod is mounted on it, stopped ones too. */
  async deleteVolume(id: string): Promise<void> {
    // a deploy under way may be putting a pod on it that RunPod does not list yet
    if (this.deploying) throw httpError("A deploy is under way: wait for it to end.", 409);
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const [volumes, pods] = await Promise.all([client.volumes(), client.pods()]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const volume = volumes.find((v) => v.id === id);
    if (!volume) throw httpError("That network volume is not on this account any more.", 404);
    const on = mountedOn(id, pods, s.machines);
    if (on.length) throw httpError(`The volume "${volume.name}" is mounted on ${on.map((p) => `${p.name} (${p.status === "EXITED" ? "stopped" : p.status.toLowerCase()})`).join(", ")}: terminate ${on.length === 1 ? "that pod" : "those pods"} first.`, 409);
    await client.deleteVolume(id).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    console.log(`[rented] volume ${volume.name} deleted`);
    this.storageSeen = null;
    this.events.emit("setup");
  }

  /**
   * A GPU deployed, as the user asked in the Deploy dialog: a new pod of that GPU, in its freest data center first (in the
   * volume's, with one), its ComfyUI locked from its first second by a token kept as a RunPod secret, its watchdog armed,
   * only ComfyUI's port open; added as a machine at once, and the choices kept for the next deploy. Refused at a spending
   * cap. Billed from now: on the user's click, or by the GPU hunt the user started (hunt.ts), never otherwise.
   */
  async deploy(ask: DeployAsk, o: { fill?: boolean } = {}): Promise<{ id: string; dataCenter: string | null }> {
    if (this.deploying) throw refused("A deploy is under way: wait for it to end.", "busy");
    this.deploying = true;
    try {
      return await this.deployNow(ask, o.fill ?? false);
    } finally {
      this.deploying = false;
    }
  }

  /**
   * The cheapest GPU in stock where a volume is, to fill it: what Fill from a set… deploys (said with its price first).
   * Null when none is free there now.
   */
  async fillGpu(volume: string): Promise<{ gpu: GpuOffer; volume: NetworkVolume } | null> {
    const found = (await this.volumes()).find((v) => v.id === volume);
    if (!found) throw httpError("That network volume is not on this account any more.", 404);
    if (found.usedBy) throw httpError(inUseSaid(found.name, found.usedBy), 409);
    const offers = await this.gpus("SECURE");
    const gpu = offers.filter((g) => g.dataCenters.some((d) => d.id === found.dataCenter && d.availability !== "NONE")).sort((a, b) => a.price - b.price)[0];
    return gpu ? { gpu, volume: found } : null;
  }

  /**
   * A pod deployed only to fill a volume with these files (Fill from a set…): the cheapest GPU in stock there, Afflatus's
   * image, no render given to it, terminated once its files are in. Billed from now, as any deploy, on the user's click.
   */
  async fill(volume: string, set: string, files: PresetFile[]): Promise<{ id: string; dataCenter: string | null }> {
    const found = await this.fillGpu(volume);
    if (!found) throw httpError("No GPU is free where that volume is now: try again later.", 409);
    return this.deploy({ gpu: found.gpu.id, cloud: "SECURE", template: "afflatus", volume, disk: 20, idleMinutes: 5, idleDo: "terminate", watchdogMinutes: 15, set, files, leaveOut: [], accept: [], again: false, makeRoom: false }, { fill: true });
  }

  private async deployNow(ask: DeployAsk, fill = false): Promise<{ id: string; dataCenter: string | null }> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    // a pod made that cannot be kept as a machine would have to be terminated at once, its first seconds billed
    if (s.machines.length >= MAX_MACHINES) throw httpError(`Afflatus keeps ${MAX_MACHINES} ComfyUIs at most: remove one to deploy.`, 409);
    if (await this.capped()) throw refused("A spending cap is reached: raise it in Settings › Rented GPUs to deploy.", "cap");
    // an image RunPod could not pull would leave a pod provisioning, billed, until its boot limit: asked of its registry first
    const client = this.client(s.runpodKey);
    const [offers, volumes, pods] = await Promise.all([client.gpus(ask.cloud), ask.volume ? client.volumes() : Promise.resolve([]), ask.volume ? client.pods() : Promise.resolve([])]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const offer = offers.find((g) => g.id === ask.gpu);
    if (!offer) throw refused(`RunPod does not offer that GPU on ${ask.cloud === "COMMUNITY" ? "Community" : "Secure"} Cloud now: pick another.`, "noGpu");
    const volume = ask.volume ? volumes.find((v) => v.id === ask.volume) ?? null : null;
    if (ask.volume && !volume) throw httpError("That network volume is not on this account any more: pick another, or deploy without one.", 409);
    // one running pod per volume: a second would write over what the first keeps there
    const taken = volume ? usedBy(volume.id, pods, s.machines) : null;
    if (volume && taken) throw refused(inUseSaid(volume.name, taken), "volumeBusy");
    const listed = offer.dataCenters.filter((d) => d.availability !== "NONE" && (!volume || d.id === volume.dataCenter)).sort((a, b) => FREEST[a.availability] - FREEST[b.availability]).map((d) => d.id);
    // RunPod said it is free without saying where: wherever it puts it (never with a volume, which has its own)
    const places: Array<string | null> = listed.length || volume || offer.dataCenters.length || offer.availability === "NONE" ? listed : [null];
    const none = volume ? `No ${offer.name} free in ${volume.dataCenter}, where the volume "${volume.name}" is: pick another GPU, or deploy without the volume.` : `No ${offer.name} free any more: it was taken since the list was read. Pick another GPU.`;
    if (!places.length) throw refused(none, "noGpu");
    // the image's build for this GPU: CUDA 13 where its hosts offer it, else 12.8 (and 12.8 again where no host of 13 is free);
    // each asked of its registry first: one RunPod could not pull would leave a pod billed until its boot limit
    const builds = [];
    for (const build of ask.template === "afflatus" && offer.cuda13 ? [imageFor("afflatus", true), imageFor("afflatus", false)] : [imageFor(ask.template, false)]) {
      if ((await this.imageReady(build.image)) !== false) builds.push(build);
    }
    if (!builds.length) {
      throw httpError(ask.template === "afflatus" ? "The Afflatus image is not published yet, or not public: nothing was deployed. Deploy with RunPod's ComfyUI meanwhile." : "RunPod's ComfyUI image cannot be pulled from Docker Hub now: nothing was deployed.", 409);
    }
    // its token kept as a secret of the account, named now (the pod has no id yet); in its environment when the key cannot
    // make secrets, as for a pod added
    const token = newToken();
    const tag = randomUUID().slice(0, 8);
    const secret = `afflatus-${tag}`;
    const kept = await client.putSecret(secret, token, `Afflatus: the lock of a deployed ${offer.name}'s ComfyUI`).then(() => true, (err: Error) => {
      console.warn(`[rented] deploy: its token kept in its environment, RunPod made no secret of it (${err.message})`);
      return false;
    });
    // without a volume a stop keeps nothing: the watchdog terminates it, as its idle does
    const end = volume ? ask.idleDo : "terminate";
    const spec: PodSpec = {
      name: `Afflatus ${offer.name} ${tag}`, image: builds[0]!.image, minCuda: builds[0]!.minCuda, gpu: offer.id, cloud: ask.cloud, dataCenter: null, disk: volume ? Math.min(ask.disk, 40) : ask.disk,
      // the Afflatus image's boot log too, to the pod's token only: an image without it (RunPod's, 0.1.11) has nothing there
      volume: volume?.id ?? null, ports: [`${COMFY_PORT}/http`, ...(ask.template === "afflatus" ? [`${BOOT_PORT}/http`] : [])], env: { [LOCK_ENV]: kept ? secretRef(secret) : token, [WATCHDOG_ENV]: String(ask.watchdogMinutes), [WATCHDOG_ACTION_ENV]: end },
    };
    // its name kept before RunPod is asked: a stop of Afflatus before its machine is saved, or an answer lost, would leave a
    // pod billed that nothing follows; the next read of RunPod finds it by this name and terminates it (settlePending)
    await updateSettings(this.db, (current) => ({ pendingDeploys: [...current.pendingDeploys, { name: spec.name, secret: kept ? secret : "", at: new Date(this.now()).toISOString() }] }));
    const settled = () => updateSettings(this.db, (current) => ({ pendingDeploys: current.pendingDeploys.filter((p) => p.name !== spec.name) }));
    // RunPod may have made the pod after all (no answer, and none listed by its name after looking again): its name is kept
    let lost = false;
    let pod: Pod | null = null;
    let image = "";
    try {
      // one data center after the other, the freest first: RunPod takes one GPU type and one place at a time, and says only
      // in words that none was free there
      for (const build of builds) {
        for (const place of places) {
          image = build.image;
          pod = await client.create({ ...spec, ...build, dataCenter: place }).catch(async (err: unknown) => {
            if (noCapacity(err)) return null;
            // no answer, a 5xx or an answer not read: RunPod may have made it all the same. Looked for by its name, it is
            // kept (a machine, watched like any) rather than left billing with nothing to stop it
            const status = (err as RunpodError).status;
            if (!(err instanceof RunpodShape) && status !== 0 && !(status >= 500)) throw err;
            for (let tries = 0; tries < 4; tries++) {
              if (tries) await new Promise((r) => setTimeout(r, this.lookAgainMs));
              const made = await client.pods().then((all) => all.find((p) => p.name === spec.name && p.status !== "TERMINATED") ?? null, () => null);
              if (made) return made;
            }
            lost = true;
            throw err;
          });
          if (pod) break;
        }
        if (pod) break;
      }
    } catch (err) {
      // a pod that may be there keeps its name and its secret (it reads its lock from it at its start) until it is settled
      if (!lost) {
        await settled();
        if (kept) await client.deleteSecret(secret).catch(() => {});
      }
      throw (err as RunpodError).status === 402 ? refused((err as Error).message, "balance") : httpError((err as Error).message, 502);
    }
    if (!pod) {
      await settled();
      if (kept) await client.deleteSecret(secret).catch(() => {});
      throw refused(none, "noGpu");
    }
    const made = pod;
    const id = podMachineId(made.id);
    try {
      await updateSettings(this.db, (current) => {
        const names = new Set(current.machines.map((m) => m.name));
        let name = offer.name.slice(0, 36);
        for (let n = 2; names.has(name); n++) name = `${offer.name.slice(0, 36)} ${n}`;
        // without a volume a stop keeps nothing and its GPU may be taken meanwhile: terminated, as for a pod added
        const rented = { provider: "runpod" as const, pod: made.id, idleMinutes: ask.idleMinutes, idleDo: volume ? ask.idleDo : ("terminate" as const), watchdogMinutes: ask.watchdogMinutes, openPorts: false, closedPorts: [], secret: kept ? secret : "", deployed: true, deployedAt: new Date(this.now()).toISOString(), image, cloud: ask.cloud, volume: volume?.id ?? "", fill, files: ask.files, leaveOut: ask.leaveOut, makeRoom: ask.makeRoom };
        const machines = [...current.machines, { id, name, url: podUrl(made.id), dir: "", takes: "all" as const, families: {}, token, rented }];
        // a machine now: followed as any, its name no longer pending (in the same write, never one without the other)
        const pendingDeploys = current.pendingDeploys.filter((p) => p.name !== spec.name);
        // the next deploy starts from the same choices; the files are this one's. A fill is not a deploy of the user's choices
        return fill ? { machines, pendingDeploys } : { machines, pendingDeploys, lastDeploy: { ...ask, files: [], leaveOut: [], accept: [] } };
      });
    } catch (err) {
      // not kept as a machine: nothing here would ever stop it, so it goes at once; a terminate refused keeps its name
      // pending, for the next read to terminate it again
      const gone = await client.act(made.id, "terminate").then(() => true, () => false);
      if (gone) {
        await settled().catch(() => {});
        if (kept) await client.deleteSecret(secret).catch(() => {});
      }
      throw err;
    }
    // a fill takes no render from its first second, not from the next read
    if (fill) this.filling.add(id);
    console.log(`[rented] deployed ${offer.name} in ${made.dataCenter ?? "a data center"} (${ask.template}, ${volume ? `volume ${volume.name}` : "no volume"})`);
    this.events.emit("setup");
    void this.poll();
    return { id, dataCenter: made.dataCenter };
  }

  /** The user's pods on RunPod, for adding one (Settings › Rented GPUs): which expose ComfyUI, which are added already. */
  async pods(): Promise<Array<Pod & { comfy: boolean; added: string | null }>> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it first.", 409);
    const pods = await this.client(s.runpodKey).pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    // which are machines, read once RunPod answered: a deploy that ended meanwhile saved its machine after the settings above
    // were read, and its pod was listed as one to add ("Afflatus A40 … provisioning") until the next read
    const { machines } = await readSettings(this.db);
    // never a pod's environment: it may hold a token in the clear (a pod whose key could not make a secret), or the user's own
    return pods.filter((p) => p.status !== "TERMINATED").map(({ env: _env, ...p }) => ({ ...p, env: {}, comfy: exposesComfy(p as Pod), added: machines.find((m) => m.rented?.pod === p.id)?.id ?? null }));
  }

  /**
   * Whether each image a deploy may run can be pulled now (podImage.ts), as Deploy a GPU shows it; null where the registry
   * did not answer. Asked again after a minute (one not there yet may be published meanwhile), ten when it is there.
   */
  async images(): Promise<Record<keyof typeof POD_IMAGES, boolean | null>> {
    const [afflatus, runpod] = await Promise.all([this.imageReady(imageFor("afflatus", true).image), this.imageReady(POD_IMAGES.runpod())]);
    return { afflatus, runpod };
  }

  private imagesSeen = new Map<string, { at: number; ready: boolean | null }>();
  /** The registry's answer for an image (a test's stand-in in place of imagePublic). */
  imageCheck: (image: string) => Promise<boolean | null> = (image) => imagePublic(image);

  private async imageReady(image: string): Promise<boolean | null> {
    const seen = this.imagesSeen.get(image);
    if (seen && this.now() - seen.at < (seen.ready ? 10 * 60_000 : 60_000)) return seen.ready;
    const ready = await this.imageCheck(image);
    this.imagesSeen.set(image, { at: this.now(), ready });
    return ready;
  }

  /** Refused when the volume a pod is on has another pod running (or starting) on it: two would spoil what it keeps. */
  protected async volumeFree(m: Machine, s: Settings): Promise<void> {
    const client = this.client(s.runpodKey);
    const pods = await client.pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const volume = pods.find((p) => p.id === m.rented!.pod)?.volumeId || m.rented!.volume;
    if (!volume) return;
    const taken = usedBy(volume, pods.filter((p) => p.id !== m.rented!.pod), s.machines.filter((x) => x.id !== m.id));
    if (!taken) return;
    const name = (await client.volumes().catch(() => [])).find((v) => v.id === volume)?.name ?? volume;
    throw httpError(inUseSaid(name, taken), 409);
  }

  /**
   * What the pod reads as it starts, set before Start: the machine's token (made now if it has none), which the node pack
   * locks its ComfyUI with from its first second (lock.py AFFLATUS_TOKEN), and the watchdog's minutes, which arm it from its
   * first second too (watchdog.py), so that a PC gone silent right after Start still has the pod stop. Only on a stopped pod,
   * read again just before (an edit made on RunPod's site since the last read is kept), and only when RunPod said its
   * environment: writing it replaces the whole of it. RunPod refusing it is said in the log and on the card; the pod starts
   * all the same, and is locked once it is up.
   */
  protected async prepareBoot(m: Machine, key: string): Promise<string | null> {
    if (!m.token) {
      const made = newToken();
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id ? { ...x, token: x.token || made } : x)) }));
      m.token = (await readSettings(this.db)).machines.find((x) => x.id === m.id)?.token || made;
    }
    try {
      const client = this.client(key);
      // a pod just stopped is still stopping on RunPod's side for some seconds: waited for, or it would start unprepared
      let pod: Pod | null = null;
      for (const ends = this.now() + SETTLE_MS; ; ) {
        pod = await client.pod(m.rented!.pod);
        if (!pod || pod.status === "EXITED" || pod.status === "ERROR" || this.now() >= ends) break;
        await new Promise((r) => setTimeout(r, this.settleEveryMs));
      }
      if (!pod) return null;
      if (pod.status !== "EXITED" && pod.status !== "ERROR") throw new Error(`RunPod still said it was ${pod.status.toLowerCase()} ${SETTLE_MS / 1000} s after it was stopped`);
      if (!pod.env) throw new Error("RunPod did not say the pod's environment, which Afflatus does not overwrite blind");
      const minutes = String(m.rented!.watchdogMinutes);
      // the token kept as a secret of the account (encrypted at RunPod, given to the pod at boot): its environment, which
      // anyone with access to the account reads in the clear, holds only the reference. Plain when the key cannot make one
      const secret = secretOf(m);
      const token = await client.putSecret(secret, m.token, `Afflatus: the lock of ${m.name || pod.id}'s ComfyUI`).then(() => secretRef(secret), (err: Error) => {
        console.warn(`[rented] ${m.name || m.id}: its token kept in its environment, RunPod made no secret of it (${err.message})`);
        return m.token;
      });
      // its other public ports closed (a template's FileBrowser, JupyterLab, SSH: logins of their own, outside the lock), and
      // remembered: kept open, those Afflatus closed are put back
      const own = ownPorts(m);
      const closed = m.rented!.closedPorts;
      const ports = m.rented!.openPorts ? [...new Set([...pod.ports, ...closed])] : pod.ports.filter((p) => own.includes(p));
      const portsChange = ports.length !== pod.ports.length || ports.some((p) => !pod.ports.includes(p));
      // what its watchdog does, as its idle does: terminate a pod that keeps nothing when stopped
      const end = pod.networkVolume || pod.diskGb > 0 ? m.rented!.idleDo : "terminate";
      if (pod.env[LOCK_ENV] === token && pod.env[WATCHDOG_ENV] === minutes && pod.env[WATCHDOG_ACTION_ENV] === end && !portsChange) return null;
      await client.update(pod.id, { env: { ...pod.env, [LOCK_ENV]: token, [WATCHDOG_ENV]: minutes, [WATCHDOG_ACTION_ENV]: end }, ...(portsChange ? { ports } : {}) });
      if (portsChange) {
        const nowClosed = m.rented!.openPorts ? [] : [...new Set([...closed, ...pod.ports.filter((p) => !own.includes(p))])];
        await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, closedPorts: nowClosed } } : x)) }));
      }
      return null;
    } catch (err) {
      const said = `Its lock and watchdog could not be set for its start (${(err as Error).message}): it is locked once it is up.`;
      console.warn(`[rented] ${m.name || m.id}: ${said}`);
      return said;
    }
  }
}
