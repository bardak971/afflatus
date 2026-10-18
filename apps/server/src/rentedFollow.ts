import { randomUUID } from "node:crypto";
import { httpError } from "./errors";
import { BOOT_PORT, RunpodError, tokenSecret, type Pod } from "./runpod";
import { stepSaid, type PresetFile } from "@afflatus/core";
import { recordMeasure } from "./podMeasures";
import { bootPacks, type BootLog } from "./podBoot";
import { SEARCHED_FOLDERS } from "./modelSets";
import { noteFill, recordHoldings } from "./rentedVolumes";
import { dollars, machineSaid } from "./notifyWords";
import { readSettings, updateSettings, type Machine, type Settings } from "./settings";
import { resetRun, type RentedView, type Seen } from "./rentedModel";
import { capReached, HOUR, RentedBilling } from "./rentedBilling";

/**
 * A deploy's name RunPod has not listed for this long is forgotten (settlePending): RunPod lists a pod it made within
 * seconds, and late within minutes, never hours.
 */
const PENDING_FORGET_MS = 30 * 60_000;
/** A pod not seen for longer than this was run while Afflatus was away (asleep, closed): when it stopped is not known. */
const AWAY_MS = 90_000;

export const TRANSITIONAL: ReadonlySet<string> = new Set(["PROVISIONING", "STARTING"]);
/**
 * Billed by RunPod: running, and on its way up (a pod provisioning or starting holds its GPU). Counted from then, so that a
 * pod slow to come up reaches a cap too; RunPod's bill stays the reference.
 */
export const BILLED: ReadonlySet<string> = new Set(["RUNNING", "STARTING", "PROVISIONING"]);
/** How often the folders of a volume a pod runs on are listed, to keep what it holds (rentedVolumes.ts). */
const VOLUME_LIST_MS = 5 * 60_000;
/** After a cap, how long a render that does not end is waited for before the pod is stopped all the same. */
const CAP_GRACE_MS = 60 * 60_000;
/**
 * How long a render on a pod may stay silent (no step, no node, no preview from ComfyUI) before it is failed as stuck: a
 * render that hangs would otherwise keep its pod billed for ever (idle never comes while it runs). Its silence counts from
 * the start when its GPU is read idle, else only past its forecast, capped (queue.ts quietFor).
 */
const STUCK_MS = 10 * 60_000;
/** How long RunPod is asked less often after it said to slow down (429). */
const BACK_OFF_MS = 60_000;
/** A pod running this long without its ComfyUI ever answering did not come up (its container failed): its idle action applies. */
const BOOT_LIMIT_MS = 10 * 60_000;
/**
 * The same for a pod deployed from Afflatus: its first start pulls its image (several GB), which RunPod says may take long
 * on a host that never had it.
 */
const DEPLOYED_BOOT_LIMIT_MS = 20 * 60_000;

/** How long a pod may run without its ComfyUI answering before its idle action applies. */
export const bootLimit = (m: Machine) => (m.rented?.deployed ? DEPLOYED_BOOT_LIMIT_MS : BOOT_LIMIT_MS);

/** The RunPod secret its token is kept in. */
export const secretOf = (m: Machine) => m.rented!.secret || tokenSecret(m.rented!.pod);

/**
 * A fill whose files moved by nothing this long (not a byte, not a file done) is cut short: a fill pod takes no render, so
 * a download stuck on it would keep it billed for ever while its ComfyUI answers.
 */
const FILL_STALL_MS = 30 * 60_000;
/**
 * However it moves, a fill is cut short this long after its deploy: two hours (its boot, the files already there checked),
 * plus its known bytes at 10 MB/s, the slow end of what a pod fetches at (RunPod's data centers mostly do many times that),
 * and 10 GB for a file of a size not known. Room for a fill that goes slowly, a bound on one that crawls.
 */
const fillLimitMs = (files: readonly PresetFile[]) => 2 * HOUR + (files.reduce((n, f) => n + (f.size || 10e9), 0) / 10e6) * 1000;
/** What a fill's note says when its pod was terminated before its files were in, by why. */
const FILL_CUT: Partial<Record<NonNullable<RentedView["stoppedBy"]>, string>> = {
  idle: "its ComfyUI stopped answering",
  cap: "a spending cap was reached",
  boot: "its ComfyUI did not come up",
  gpu: "its GPU did not work on that host",
  start: "its start stopped on an error",
  crash: "its ComfyUI died",
  watchdog: "its pod was found stopped",
  you: "its pod was terminated by you",
};

/** How many of ComfyUI's last lines a render its death failed keeps (its pod serves 300), and how much of that report at most. */
const CRASH_LINES = 200;
const CRASH_TRACE = 64_000;

/** A pod still running this long after Afflatus asked RunPod to stop it is asked again (and a stop that keeps nothing, terminated). */
const STOP_AGAIN_MS = 2 * 60_000;
/** How often a booting pod's boot log is read (podBoot.ts), and how long after its ComfyUI first answered it still is. */
const BOOT_READ_MS = 10_000;
const BOOT_TAIL_MS = 2 * 60_000;
/** The log tab reads it every two seconds while it is open: read again at most this often then. */
const BOOT_ASKED_MS = 2_000;

/**
 * The follow loop of rented pods (rented.ts): RunPod read every few seconds, each pod's run followed through its boot, its
 * answers, its idle time and the caps, its sessions kept, "still here" said to its watchdog, and the stops and
 * terminates Afflatus makes.
 */
export class RentedFollow extends RentedBilling {
  bootEveryMs = BOOT_READ_MS;

  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  /** One more read asked for while `polling` runs: it follows that one. */
  private pollAgain: Promise<void> | null = null;
  /** A read is saying "setup" itself: not a change to read again for. */
  private announcing = false;
  /** Stopped for good (Afflatus shutting down): no read starts, a follow-up read included. */
  private stopped = false;

  /** How often RunPod is read: every `everyMs`, every `fastMs` while a pod is starting or stopping. */
  everyMs = 20_000;
  fastMs = 3_000;
  /**
   * Lock a pod's ComfyUI (lock-api.ts lockMachine): a rented machine is reached at a public address, so one that came up
   * unlocked (RunPod did not take the token for its start) is locked as soon as it is up, when its node pack can.
   */
  lockPod: ((machine: string) => Promise<unknown>) | null = null;

  /** How long a render on a pod may stay silent before it is failed as stuck (STUCK_MS; shorter in tests). */
  stuckMs = STUCK_MS;

  /** Start reading RunPod, in the background; again at once when the settings change. */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.kick(0);
    // a change of the setup (a machine added, a cap changed) is read at once; never the one a read itself announces, or each
    // read would start the next
    this.events.on("setup", () => {
      if (!this.announcing) void this.poll().catch(() => {});
    });
  }

  private running = false;

  /** Whether work from outside Afflatus is being timed on a pod (podOutside.ts; set by services.ts): its queue is read at each pass then. */
  outsideTimed: (machine: string) => boolean = () => false;

  /** The next read in `ms`, the one waiting put off: a pod just started or stopped is followed at the fast pace at once. */
  private kick(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(ms, this.quietUntil - this.now()));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.poll().catch((err: Error) => console.warn(`[rented] ${err.message}`));
    // a pod starting or stopping moves within seconds; one provisioning pulls its image, minutes: read at the usual pace
    const fast = [...this.seen.values()].some((s) => s.stopping || s.pod?.status === "STARTING");
    // one running whose ComfyUI has not answered yet (a boot): its card follows its boot log's steps at that log's pace
    const booting = [...this.seen.values()].some((s) => s.pod?.status === "RUNNING" && !s.answered);
    this.kick(fast ? this.fastMs : booting ? Math.min(this.everyMs, BOOT_READ_MS) : this.everyMs);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A deployed pod answered for the first time: the files its deploy asked for, and the ones it left out (services.ts hands them to podFiles). */
  onUp: ((machine: string, files: PresetFile[], leaveOut: Array<{ file: string; folder: string }>) => void) | null = null;

  /** What a pod was getting forgotten (podFiles.ts forget), its machine taken out; set by services.ts. */
  forgetFiles: ((machine: string) => void) | null = null;
  /**
   * The files a machine's pod still waits for (how many, their names), all it was given, the bytes in so far, and those that
   * failed (services.ts: podFiles).
   */
  filesLeft: ((machine: string) => { left: number; total: number; bytes: number; waiting: string[]; failed: Array<{ file: string; error: string }> }) | null = null;

  /** When each pod last listed its volume's folders (ms), by machine and volume: at most every VOLUME_LIST_MS, a new pod at its first answer. */
  private volumeListed = new Map<string, number>();

  /**
   * What the volume a pod runs on holds, listed through its ComfyUI and kept (what a volume holds once no pod is on it),
   * at most every few minutes; and that the volume was used now. Never in the way of the poll: a failure is only said.
   */
  private async noteVolume(m: Machine, volume: string): Promise<void> {
    const key = `${m.id}|${volume}`;
    const last = this.volumeListed.get(key) ?? 0;
    if (this.now() - last < VOLUME_LIST_MS) return;
    this.volumeListed.set(key, this.now());
    const comfy = await this.comfyOf(m.id);
    if (!comfy) return;
    await recordHoldings(this.db, volume, comfy, m.name || m.id, SEARCHED_FOLDERS, this.now()).catch((err: Error) => console.warn(`[rented] what the volume of ${m.name || m.id} holds was not read: ${err.message}`));
  }

  /**
   * Read RunPod now: every rented machine's pod, their sessions, the watchdog's "still here", idle and caps. Asked while a
   * read runs, one more follows it (shared by everyone who asks meanwhile): the running one read the settings before the
   * ask, and a cap or an idle time just changed would otherwise wait for the next round.
   */
  poll(): Promise<void> {
    // Afflatus shutting down: nothing more is read (the database may be closed already)
    if (this.stopped) return Promise.resolve();
    if (this.polling) {
      // after the read under way, whether it went well or not (a failed one must not swallow the read asked for)
      this.pollAgain ??= this.polling.catch(() => {}).then(() => {
        this.pollAgain = null;
        return this.poll();
      });
      return this.pollAgain;
    }
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** What was spent, read once per poll and shared by every pod's cap check in it. */
  private spentThisPoll: Promise<{ today: number; month: number }> | null = null;

  private async pollOnce(): Promise<void> {
    this.spentThisPoll = null;
    const settings = await readSettings(this.db);
    const rented = settings.machines.filter((m) => m.rented);
    this.filling = new Set(rented.filter((m) => m.rented!.fill).map((m) => m.id));
    for (const id of this.seen.keys()) {
      if (rented.some((m) => m.id === id)) continue;
      this.seen.delete(id);
      this.boots.forget(id);
    }
    // a run still open for a machine that is no longer this pod (removed from Afflatus while it ran, or added again as
    // another pod) is closed now, where it was last seen running: nothing would ever close it otherwise
    const open = await this.db.selectFrom("rent_sessions").select(["id", "machine_id", "pod", "seen_at"]).where("ended_at", "is", null).execute();
    for (const r of open.filter((x) => !rented.some((m) => m.id === x.machine_id && m.rented!.pod === x.pod))) {
      await this.db.updateTable("rent_sessions").set({ ended_at: r.seen_at ?? new Date(this.now()).toISOString() }).where("id", "=", r.id).execute();
    }
    if (!rented.length && !settings.leftSecrets.length && !settings.pendingDeploys.length) return;
    if (!settings.runpodKey) {
      if (!rented.length) return;
      this.error = "No RunPod API key: set it in Settings › Rented GPUs.";
      this.events.emit("queue");
      return;
    }
    if (this.now() < this.quietUntil) {
      await this.pingAll(rented, settings.rentCaps);
      return;
    }
    // what each machine's state was before this read: an action taken while it was under way wins over what it read
    const epochs = new Map(rented.map((m) => [m.id, this.seenOf(m.id).epoch]));
    let pods: Pod[];
    try {
      pods = await this.client(settings.runpodKey).pods();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      if (err instanceof RunpodError && err.status === 429) this.quietUntil = this.now() + BACK_OFF_MS;
      // RunPod not answering is not this PC going silent: the pods still hear "still here", and render on, short of a cap
      await this.pingAll(rented, settings.rentCaps);
      this.events.emit("queue");
      return;
    }
    await this.sweepSecrets(settings, pods);
    await this.settlePending(settings, pods);
    await this.readBalance(settings.runpodKey);
    let changed = false;
    for (const m of rented) {
      const s = this.seenOf(m.id);
      if (s.epoch !== epochs.get(m.id)) continue;
      try {
        changed = (await this.follow(m, s, pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null, settings.rentCaps, settings.runpodKey)) || changed;
        s.error = null;
      } catch (err) {
        // one pod RunPod refuses something for says so on its card; the others go on being watched
        changed = changed || s.error !== (err as Error).message;
        s.error = (err as Error).message;
      }
    }
    if (changed) {
      this.events.emit("queue");
      // a pod that came up, or went: what waited for it may go, what it held is read again
      this.announcing = true;
      try {
        this.events.emit("setup");
      } finally {
        this.announcing = false;
      }
    }
  }

  /**
   * The deploys whose machine was never saved (pendingDeploys), settled while no deploy runs (one under way has its own name
   * there, its pod not a machine yet): a pod RunPod lists by that name that no machine has is terminated (nothing here
   * follows it: no idle stop, no cap, and a RunPod-image pod has no watchdog); one a machine has was saved after all; a name
   * RunPod has not listed for PENDING_FORGET_MS is forgotten. Each settled name's secret goes to leftSecrets, deleted once
   * its pod is gone.
   */
  private async settlePending(settings: Settings, pods: Pod[]): Promise<void> {
    if (this.deploying || !settings.pendingDeploys.length) return;
    const client = this.client(settings.runpodKey);
    const done: Array<{ name: string; secret: string; pod: string }> = [];
    for (const p of settings.pendingDeploys) {
      const pod = pods.find((x) => x.name === p.name && x.status !== "TERMINATED");
      if (pod && settings.machines.some((m) => m.rented?.pod === pod.id)) {
        done.push({ name: p.name, secret: "", pod: pod.id });
        continue;
      }
      if (pod) {
        const ok = await client.act(pod.id, "terminate").then(() => true, (err: Error) => (console.warn(`[rented] ${pod.name}, deployed and not followed, not terminated (${err.message}): asked again at the next read`), false));
        if (!ok) continue;
        console.log(`[rented] ${pod.name} terminated: Afflatus deployed it and lost it before following it`);
        this.tell?.("podStopped", { title: `${pod.name} terminated`, body: "Why: Afflatus lost its deploy before following it (it stopped mid-deploy, or RunPod's answer was lost), so nothing here would have stopped it.", key: `pending:${pod.id}` });
        done.push({ ...p, pod: pod.id });
        continue;
      }
      if (this.now() - Date.parse(p.at) > PENDING_FORGET_MS) done.push({ ...p, pod: "" });
    }
    if (!done.length) return;
    const names = new Set(done.map((d) => d.name));
    const secrets = done.filter((d) => d.secret).map((d) => ({ secret: d.secret, pod: d.pod }));
    await updateSettings(this.db, (current) => ({
      pendingDeploys: current.pendingDeploys.filter((p) => !names.has(p.name)),
      ...(secrets.length ? { leftSecrets: [...current.leftSecrets, ...secrets] } : {}),
    }));
  }

  /** The secrets of pods removed from Afflatus (leftSecrets) whose pod is gone from RunPod now: deleted, and forgotten. */
  private async sweepSecrets(settings: Settings, pods: Pod[]): Promise<void> {
    const gone = settings.leftSecrets.filter((l) => !pods.some((p) => p.id === l.pod && p.status !== "TERMINATED"));
    if (!gone.length) return;
    const client = this.client(settings.runpodKey);
    const done: string[] = [];
    for (const l of gone) {
      await client.deleteSecret(l.secret).then(() => done.push(l.secret), (err: Error) => console.warn(`[rented] the secret of a removed pod not deleted (${err.message})`));
    }
    if (done.length) await updateSettings(this.db, (current) => ({ leftSecrets: current.leftSecrets.filter((l) => !done.includes(l.secret)) }));
  }

  /** The pod's secret (its token) deleted on RunPod, once: the pod is gone. */
  private async dropSecret(m: Machine, s: Seen, key: string): Promise<void> {
    if (s.secretDropped) return;
    s.secretDropped = true;
    await this.client(key).deleteSecret(secretOf(m)).catch((err: Error) => {
      s.secretDropped = false;
      console.warn(`[rented] ${m.name || m.id}: its secret on RunPod not deleted (${err.message})`);
    });
  }

  /** One machine's pod as just read: its session, "still here", its lock, idle and caps. Says whether anything changed. */
  private async follow(m: Machine, s: Seen, pod: Pod | null, caps: { day: number; month: number }, key: string): Promise<boolean> {
    const before = s.pod;
    s.missing = pod ? 0 : s.missing + 1;
    // one read without a pod that the read before had: taken as a read that did not come, not as the pod gone (an answer of
    // RunPod's can come back short), unless RunPod says of that pod itself that it is gone. Its session, idle clock, cap and
    // a stop under way are kept as they were; only a second read without it closes its run, or each short answer would give
    // an idle pod a new idle time, drop a stop's retry and split its run in two
    if (!pod && s.missing < 2 && s.pod !== null && (await this.client(key).exists(m.rented!.pod)) !== false) return false;
    // gone from RunPod (terminated there, or by its watchdog): only once RunPod says so of that pod itself, at a second read
    // without it. Its list may lag a pod just made (whose secret it still has to read at its boot), an answer of RunPod's may
    // come back empty, and a key of another account lists none of these: none of that is a pod gone
    const gone = !pod && s.missing >= 2 && !m.rented!.deployedAt && (await this.client(key).exists(m.rented!.pod)) === false;
    if (gone) await this.dropSecret(m, s, key);
    // a deployed pod that came up once (its ComfyUI answered) and is gone: nothing is left of it, its machine goes too. Never
    // for one that did not come up (its card says why)
    if (gone && m.rented!.deployed && s.stoppedBy !== "gpu" && s.stoppedBy !== "boot" && s.stoppedBy !== "crash") {
      await this.forget(m, s);
      console.log(`[rented] ${m.name || m.id}: gone from RunPod, taken out of Afflatus`);
      return true;
    }
    // a pod gone stays gone: said once, not at every read
    const changed = !s.read || (before?.status ?? null) !== (pod?.status ?? null) || Boolean(pod?.cost && pod.cost !== s.rate);
    if (pod?.status === "RUNNING") await this.containerUp(m, s, pod, key);
    else s.containerAt = null;
    // a deployed pod's container up (RunPod says its uptime from then): its card goes from pulling the image to ComfyUI
    // starting at once, not at the next change
    if (m.rented!.deployedAt && (before?.uptime ?? null) === null && pod?.uptime !== null && pod?.uptime !== undefined) this.events.emit("queue");
    s.read = true;
    s.pod = pod;
    if (pod?.cost) s.rate = pod.cost;
    // the rate of its last run here, until RunPod says one (it says 0 while the pod is stopped)
    s.rate ??= (await this.db.selectFrom("rent_sessions").select("rate").where("pod", "=", m.rented!.pod).orderBy("started_at", "desc").executeTakeFirst())?.rate || null;
    await this.session(m, pod, s);
    // its container up (RunPod says its uptime from then): its image pulled, kept on its session for the Costs tab's split of
    // its boot. From its uptime, not from now: right after a restart of Afflatus mid-boot too
    if (pod?.status === "RUNNING" && pod.uptime !== null && !s.pulledKept) {
      s.pulledKept = true;
      await this.notePulled(m, this.now() - pod.uptime * 1000);
    }
    // deployed and never up yet, for too long: its image does not pull, or its container does not start; billed for nothing
    const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
    if (pod && TRANSITIONAL.has(pod.status) && Number.isFinite(deployedAt) && this.now() - deployedAt >= DEPLOYED_BOOT_LIMIT_MS) {
      await this.noteFailed(m, "its start, never under way");
      await this.act(m, "terminate", "boot");
      return true;
    }
    // deployed, never up, and still not listed past its boot limit (terminated on RunPod's side, or never made there): it is
    // not starting on its volume any more, which would otherwise stay "in use" for ever
    if (!pod && Number.isFinite(deployedAt) && this.now() - deployedAt >= DEPLOYED_BOOT_LIMIT_MS) await this.undeploy(m);
    // any pod starting or provisioning that long (one added and started, its host unable to bring it up) is billed for
    // nothing: stopped as its idle choice says, as a boot that never answers is
    s.startingSince = pod && TRANSITIONAL.has(pod.status) ? s.startingSince ?? this.now() : null;
    if (s.startingSince !== null && !Number.isFinite(deployedAt) && this.now() - s.startingSince >= bootLimit(m) && !s.stopping) {
      await this.noteFailed(m, "its start, never under way");
      await this.act(m, m.rented!.idleDo, "boot");
      return true;
    }
    // a deployed pod without a volume found stopped (its watchdog stopped it while Afflatus was away, or RunPod did): it keeps
    // nothing and its GPU may be taken, so nothing is left of it on the account. A stop of the user's own is left as it is
    // A fill pod found stopped (a stop of an older Afflatus's at a cap, or RunPod's) goes too: stopped, it keeps its volume
    // mounted (never deleted then) and fills nothing
    if (pod?.status === "EXITED" && m.rented!.deployed && (m.rented!.fill || (!pod.networkVolume && pod.diskGb === 0)) && s.stoppedBy !== "you" && !m.rented!.userStopped && !s.stopping) {
      await this.act(m, "terminate", "watchdog");
      return true;
    }
    // a cap reached while it starts or provisions (by another pod's spending, or the bill read since its Start): it would
    // come up billed and only then stop. Stopped now, or terminated as capAction says; asked again if it is still at it a
    // while after
    if (pod && TRANSITIONAL.has(pod.status) && (caps.day > 0 || caps.month > 0)) {
      const spent = await (this.spentThisPoll ??= this.spent());
      this.sayCap(caps, spent);
      if (capReached(caps, spent)) {
        if (s.stopping && s.stoppingSince !== null && this.now() - s.stoppingSince < STOP_AGAIN_MS) return changed;
        const again = s.stopping;
        s.stopping = false;
        await this.act(m, this.capAction(m, pod), "cap", again);
        return true;
      }
    }
    if (pod?.status !== "RUNNING") {
      resetRun(s);
      if (s.stopping && pod?.status !== "STARTING") {
        s.stopping = false;
        s.stoppingSince = null;
      }
      if (!pod || !TRANSITIONAL.has(pod.status)) s.bootNote = null;
      return changed;
    }
    if (s.stoppedBy && !before) s.stoppedBy = null;
    // being stopped and still running: no "still here" (its own watchdog may stop it if RunPod does not), and after a while the
    // stop is asked again (a pod that keeps nothing terminated)
    if (s.stopping) {
      if (s.stoppingSince !== null && this.now() - s.stoppingSince >= STOP_AGAIN_MS) {
        const why = s.stoppedBy ?? "idle";
        // the action first sent, asked again: a stop stays a stop on a pod that keeps something (the user's Stop, a cap's),
        // and becomes a terminate only on one that keeps nothing
        const sent = s.stopAction ?? m.rented!.idleDo;
        s.stopping = false;
        s.stoppingSince = null;
        console.warn(`[rented] ${m.name || m.id}: still running ${STOP_AGAIN_MS / 60_000} min after its stop: asked again`);
        await this.act(m, sent === "stop" && (pod.networkVolume || pod.diskGb > 0) ? "stop" : "terminate", why, true);
      }
      return changed;
    }
    s.upAt ??= this.now();
    // after a restart of Afflatus, idle since its last work as kept, not since now; set before its ComfyUI is asked (seconds
    // through a pod's proxy), so that its card says its idle time left from the first read on, never nothing meanwhile
    if (s.busyAt === null) ({ at: s.busyAt, restored: s.busyRestored } = await this.busySince(m, this.now()));
    // a start its boot log says stopped on an error (a step of start.sh, the GPU check) never comes up: terminated at once, not
    // billed to its boot limit. Only a pod deployed from here with Afflatus's image (none other has the log), before its
    // first answer; its last lines stay in its log tab, the boot limit stays the backstop
    const failed = m.rented!.deployed && !s.answered ? this.boots.get(m.id)?.failed : null;
    if (failed && !this.queue.runningOn(m.id)) {
      // in the words its phase line said it (stepSaid, shared with the screens), never the pod's own
      s.startFailed = `Terminated: start failed at ${stepSaid(failed)}, as its boot log says (its last lines are in its log, Queue › Log). Nothing billed after; deploy again.`;
      await this.noteFailed(m, failed);
      await this.act(m, "terminate", "start");
      return true;
    }
    const answers = await this.alive(m, s);
    // a GPU that does not work on its host never will: terminated at once, not at its boot limit
    if (s.gpuFailed && !this.queue.runningOn(m.id)) {
      await this.noteFailed(m, "checking the GPU");
      await this.act(m, "terminate", "gpu");
      return true;
    }
    // its ComfyUI died (its report, or the queue finding it started again without its render): the render failed at once with
    // why and never run again, and the pod terminated at once as a crash, not left billed to its idle time. Work from outside
    // Afflatus on it too: there is no render to fail, the pod goes all the same
    if (s.comfyDied && !s.comfyDied.told && !s.stopping) {
      await this.crashed(m, s, pod);
      return true;
    }
    if (answers && !s.answered) {
      await this.noteUp(m);
      s.answeredAt = this.now();
    }
    if (answers) s.answered = true;
    // its boot log while it boots, and a while after its first answer (ComfyUI's last lines of its start)
    if (!s.answered || (s.answeredAt !== null && this.now() - s.answeredAt < BOOT_TAIL_MS)) void this.readBoot(m, pod, this.bootEveryMs);
    // its first answer since it was deployed: later starts count from when it runs. How long it took is kept (the Deploy
    // dialog's "up in"), and what its deploy asked for is handed to it now. A fill keeps its files until it ends: podFiles
    // keeps what a pod gets in memory only, so after a restart of Afflatus they are handed again (followFill)
    if (answers && m.rented!.deployedAt) {
      if (Number.isFinite(deployedAt)) await recordMeasure(this.db, { kind: "boot", cloud: m.rented!.cloud ?? null, bytes: 0, ms: this.now() - deployedAt }).catch(() => {});
      const { files, leaveOut, fill } = m.rented!;
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, deployedAt: "", ...(fill ? {} : { files: [], leaveOut: [] }) } } : x)) }));
      if (!fill && (files.length || leaveOut.length)) this.onUp?.(m.id, files, leaveOut);
    }
    // up this long and its ComfyUI never answered: its container failed to start, or ComfyUI on it did; billed for nothing.
    // A deployed pod's first boot counts from its deploy (its image pulled first); one that never came up is terminated
    const bootFrom = Number.isFinite(deployedAt) ? Math.min(deployedAt, s.upAt) : s.upAt;
    if (!s.answered && this.now() - bootFrom >= bootLimit(m) && !this.queue.runningOn(m.id)) {
      await this.noteFailed(m, this.boots.get(m.id)?.step ?? "ComfyUI never answered");
      await this.act(m, Number.isFinite(deployedAt) ? "terminate" : m.rented!.idleDo, "boot");
      return true;
    }
    // up and open (RunPod did not take its token for the start, or it was added running): locked now, once a session
    if (answers && !s.lockTried && this.lockPod && (await this.isOpen(m))) {
      s.lockTried = true;
      await this.lockPod(m.id).catch((err: Error) => console.warn(`[rented] ${m.name || m.id} not locked: ${err.message}`));
    }
    if (answers && pod?.volumeId) void this.noteVolume(m, pod.volumeId);
    if (m.rented!.fill && (await this.followFill(m, s, pod, answers))) return true;
    await this.keepOrStop(m, s, caps, answers);
    return changed;
  }

  /**
   * A pod filling its volume, up: its files handed (again after a restart of Afflatus), terminated once they are in (what the
   * volume holds listed first), or cut short when they stop moving or take too long. Kept from going idle only while its
   * ComfyUI answers: one that went silent ends at its idle time. Says whether it was terminated.
   */
  private async followFill(m: Machine, s: Seen, pod: Pod, answers: boolean): Promise<boolean> {
    const { files, leaveOut } = m.rented!;
    const now = this.now();
    // from its first run (its deploy), kept across a restart of Afflatus as its sessions are
    s.fillFrom ??= (await this.db.selectFrom("rent_sessions").select("started_at").where("machine_id", "=", m.id).orderBy("started_at", "asc").executeTakeFirst().then((r) => (r ? Date.parse(r.started_at) : null))) ?? now;
    if (now - s.fillFrom >= fillLimitMs(files)) return this.cutFill(m, s, `it was still not done after ${Math.round((now - s.fillFrom) / 60_000)} min`);
    if (!answers) return false;
    s.busyAt = now;
    // a fill always brings files (Fill refuses a set without): none kept means what it was to fetch is not known any more
    if (!files.length) return this.cutFill(m, s, "what it was to fetch was not known any more");
    let got = this.filesLeft?.(m.id) ?? null;
    // handed once in this run of Afflatus, and again when podFiles has nothing of it (a pod seen down a moment is forgotten
    // there): an empty view is never read as all in
    if (!s.handed || got?.total === 0) {
      s.handed = true;
      s.fillProgress = null;
      this.onUp?.(m.id, files, leaveOut);
      got = this.filesLeft?.(m.id) ?? null;
    }
    if (!got || got.total === 0) return false;
    const progress = `${got.left}|${got.bytes}|${got.failed.length}`;
    if (progress !== s.fillProgress) {
      s.fillProgress = progress;
      s.fillMovedAt = now;
    }
    if (got.left > 0) return now - (s.fillMovedAt ?? now) >= FILL_STALL_MS ? this.cutFill(m, s, `nothing came for ${FILL_STALL_MS / 60_000} min`) : false;
    if (pod.volumeId) {
      this.volumeListed.delete(`${m.id}|${pod.volumeId}`);
      await this.noteVolume(m, pod.volumeId);
      // how it ended, kept with the volume: its row says it once the pod is gone (a file that failed, and why)
      await noteFill(this.db, pod.volumeId, got.failed, now).catch(() => {});
      if (got.failed.length) console.log(`[rented] ${m.name || m.id}: ${got.failed.length} of its files failed: ${got.failed.map((f) => f.file).join(", ")}`);
    }
    await this.act(m, "terminate", "filled");
    return true;
  }

  /** A fill cut short: its pod terminated, its note saying why (act writes it). */
  private async cutFill(m: Machine, s: Seen, why: string): Promise<true> {
    s.cutWhy = why;
    await this.act(m, "terminate", "cut");
    return true;
  }

  /**
   * How a fill ended when its pod was terminated before its files were in, kept with its volume: interrupted, with why, the
   * files that failed and those that never came. Never "all in".
   */
  private async noteCut(m: Machine, s: Seen, why: RentedView["stoppedBy"], got: ReturnType<NonNullable<RentedFollow["filesLeft"]>> | null): Promise<void> {
    const volume = m.rented!.volume;
    if (!volume) return;
    const said = (why === "cut" ? s.cutWhy : why ? FILL_CUT[why] : null) ?? "its pod was terminated";
    const failed = [...(got?.failed ?? []), ...(got?.waiting ?? []).map((file) => ({ file, error: "not fetched: the fill was cut short" }))];
    await noteFill(this.db, volume, failed, this.now(), said).catch(() => {});
    console.log(`[rented] ${m.name || m.id}: its fill was cut short (${said})`);
  }

  /** A deployed pod that never came up taken as not deployed any more: it no longer holds its volume as starting on it. */
  private async undeploy(m: Machine): Promise<void> {
    if (!m.rented!.deployedAt) return;
    await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, deployedAt: "" } } : x)) }));
  }

  /**
   * A pod's boot log read again (podBoot.ts), at most every `everyMs`, on a pod that exposes its port: the queue told when its
   * step or its lines moved. Never an error: a pod without it (RunPod's image, an older Afflatus image) has nothing there.
   */
  private async readBoot(m: Machine, pod: Pod | null, everyMs: number): Promise<BootLog | null> {
    if (!pod || !pod.ports.includes(`${BOOT_PORT}/http`) || !m.token) return this.boots.get(m.id);
    const before = this.boots.get(m.id);
    const after = await this.boots.read(m.id, m.rented!.pod, m.token, everyMs);
    if (after) await this.notePacks(m, after);
    if (after && (after.step !== before?.step || after.failed !== before?.failed || after.lines.at(-1)?.t !== before?.lines.at(-1)?.t)) this.events.emit("queue");
    return after;
  }

  /**
   * The boot log of a rented machine's pod for its log tab, while its ComfyUI has none to give (it does not answer yet):
   * read now (at most every BOOT_ASKED_MS), else as last read. Null for a machine that is not a rented pod.
   */
  async bootLines(machine: string): Promise<{ lines: BootLog["lines"] } | null> {
    const m = (await readSettings(this.db)).machines.find((x) => x.id === machine);
    if (!m?.rented) return null;
    const log = await this.readBoot(m, this.seen.get(m.id)?.pod ?? null, BOOT_ASKED_MS);
    return { lines: log?.lines ?? [] };
  }

  /** Whether a rented machine's ComfyUI is not up: its log tab reads its boot log then. False for a ComfyUI of its own. */
  comfyDown(machine: string): boolean {
    const s = this.seen.get(machine);
    return Boolean(s && s.answers !== true);
  }

  /** Whether its ComfyUI answers without a lock (the pack's GET /afflatus/lock says locked false). */
  private async isOpen(m: Machine): Promise<boolean> {
    const comfy = await this.comfyOf(m.id);
    const res = await comfy?.client.raw("/afflatus/lock", { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => {});
      return false;
    }
    const said = (await res.json().catch(() => null)) as { locked?: boolean } | null;
    return said?.locked === false;
  }

  /**
   * Its ComfyUI's first answer of the open session, kept on it: where its boot ended (costs.ts). Not for a session older than
   * the longest boot: Afflatus started again while it ran, and its first answer here is not its boot's end.
   */
  private async noteUp(m: Machine): Promise<void> {
    const iso = new Date(this.now()).toISOString();
    const since = new Date(this.now() - DEPLOYED_BOOT_LIMIT_MS).toISOString();
    await this.db.updateTable("rent_sessions").set({ up_at: iso }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("up_at", "is", null).where("started_at", ">=", since).execute().catch(() => {});
  }

  /**
   * Its container's start, said as its uptime: RunPod's REST list gives a booting pod none (a real one read none; only its
   * GraphQL says it). The first of its REST uptime, its boot log answering (the Afflatus image serves it from its container's
   * start: its first line), and RunPod's GraphQL, asked only while it boots and until known, its failures taken as nothing.
   * Known once, its uptime counts from then: what its card says (pulling the image, then starting) and its session keeps.
   */
  private async containerUp(m: Machine, s: Seen, pod: Pod, key: string): Promise<void> {
    if (pod.uptime !== null) s.containerAt ??= this.now() - pod.uptime * 1000;
    else if (s.containerAt === null && !s.answered) {
      const first = this.boots.get(m.id)?.lines[0]?.t;
      const logged = first ? Date.parse(first) : Number.NaN;
      // a log of this run only: one kept from a run before (a stop, a start again) is not its container's start
      const run = pod.startedAt ? Date.parse(pod.startedAt) - 60_000 : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(logged) && logged >= run) s.containerAt = Math.min(logged, this.now());
      else {
        const up = await this.client(key).uptime(pod.id).catch(() => null);
        if (up !== null) s.containerAt = this.now() - up * 1000;
      }
    }
    if (pod.uptime === null && s.containerAt !== null) pod.uptime = Math.max(0, Math.round((this.now() - s.containerAt) / 1000));
  }

  /**
   * Its container's start (its image pulled, ms) kept on its open session, before its ComfyUI first answered: the Costs tab's
   * "pulling the image". Never over one kept (a container started again later is not its pull).
   */
  private async notePulled(m: Machine, at: number): Promise<void> {
    await this.db.updateTable("rent_sessions").set({ pulled_at: new Date(Math.min(at, this.now())).toISOString() }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("pulled_at", "is", null).where("up_at", "is", null).execute().catch(() => {});
  }

  /**
   * What its boot log says of its node packs (podBoot.ts bootPacks), kept on its open session as it comes: a restart of
   * Afflatus mid-boot keeps it, and a log read later that has lost its first lines (it keeps its last 300) changes nothing kept.
   */
  private async notePacks(m: Machine, log: BootLog): Promise<void> {
    const packs = bootPacks(log.lines);
    const s = this.seen.get(m.id);
    if (!packs || !s) return;
    const said = JSON.stringify(packs);
    if (s.packsKept === said) return;
    s.packsKept = said;
    const open = await this.db.selectFrom("rent_sessions").select(["id", "packs_from", "packs_to", "boot_packs"]).where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst().catch(() => undefined);
    // its first course kept: a container started again afterwards (RunPod restarts one that stopped) is not its boot's
    if (!open || open.packs_to || (open.packs_from && open.packs_from !== packs.from)) return;
    const kept = JSON.parse(open.boot_packs ?? "[]") as Array<{ pack: string; ms: number }>;
    await this.db
      .updateTable("rent_sessions")
      .set({ packs_from: open.packs_from ?? packs.from, packs_to: packs.to, boot_packs: packs.installs.length >= kept.length ? JSON.stringify(packs.installs) : open.boot_packs })
      .where("id", "=", open.id)
      .execute()
      .catch(() => {});
  }

  /**
   * A pod whose ComfyUI died: its render failed with why (the pod's line and the step; its report and ComfyUI's last lines from
   * the boot log kept with the job), the death kept on its run (Costs), and the pod terminated as a crash when it was deployed
   * from here. One added by hand is the user's: said, never terminated.
   */
  private async crashed(m: Machine, s: Seen, pod: Pod | null): Promise<void> {
    const died = s.comfyDied!;
    // its render failed and the death kept, once: a terminate RunPod refused is asked again at the next read, not this
    if (!died.handled) {
      died.handled = true;
      const log = died.from === "pod" ? await this.readBoot(m, pod, 0).catch(() => null) : null;
      // ComfyUI's colours (its log's escape codes) left out: the job's trace is read as plain text
      const tail = log?.lines.slice(-CRASH_LINES).map((l) => `${l.t} ${l.m.replace(/\x1b\[[0-9;]*m/g, "")}`).join("\n") ?? "";
      const trace = [died.report ? `The pod's report: ${JSON.stringify(died.report)}` : null, tail ? `ComfyUI's last lines:\n${tail}` : null].filter(Boolean).join("\n\n");
      // one the queue found has failed its render already (and that ComfyUI answers: nothing to hold for it)
      if (died.from === "pod") died.render = this.queue.machineDied(m.id, died.said, trace ? trace.slice(-CRASH_TRACE) : null);
      await this.db.updateTable("rent_sessions").set({ crash: JSON.stringify({ said: died.said, report: died.report }) }).where("machine_id", "=", m.id).where("ended_at", "is", null).execute().catch(() => {});
      console.warn(`[rented] ${m.name || m.id}: ${died.said}${died.render ? " (its render failed)" : ""}`);
    }
    if (m.rented!.deployed) {
      // done only once RunPod took it: a refusal (a 429, a 5xx) throws, and the next read asks again, the pod billed meanwhile
      await this.act(m, "terminate", "crash");
      died.told = true;
      return;
    }
    died.told = true;
    this.events.emit("queue");
    this.tell?.("comfyGone", { title: `${machineSaid(m)}: ComfyUI died`, body: `${died.said}.${died.render ? " Its render failed, not run again." : ""} A pod added by hand is not terminated by Afflatus: it is still billed.`, key: `${m.id}:crash` });
  }

  /**
   * The queue found a pod's ComfyUI started again without the render it ran (queue.ts lostOnPod): its death, though its image
   * said nothing of it. Acted on at the next read, as a death the pod reports is.
   */
  podCrashed(machine: string, why: string): void {
    const s = this.seenOf(machine);
    if (s.comfyDied && !s.comfyDied.told) return;
    s.comfyDied = { said: why, report: null, from: "queue", handled: false, told: false, render: true };
    this.kick(0);
  }

  /** The step its start failed at, kept on its open session: the Costs tab's "failed starts". The first said stays. */
  private async noteFailed(m: Machine, step: string): Promise<void> {
    await this.db.updateTable("rent_sessions").set({ start_failed: step.slice(0, 200) }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("start_failed", "is", null).execute().catch(() => {});
  }

  /** The running session kept as a row: opened when it is seen running, kept seen while it runs, closed when it is not. */
  private async session(m: Machine, pod: Pod | null, s: Seen): Promise<void> {
    const open = await this.db.selectFrom("rent_sessions").selectAll().where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    const now = this.now();
    const iso = new Date(now).toISOString();
    if (pod && BILLED.has(pod.status)) {
      s.seenRunningAt = now;
      if (open) {
        // a run first seen before RunPod said its rate (0) takes the rate as soon as it says one: it was counted as free. One
        // opened at a lower rate takes the higher too: a run opened before its disk was counted in its rate (0.5.0), its
        // whole time billed with that disk
        await this.db.updateTable("rent_sessions").set({ seen_at: iso, ...(pod.cost > open.rate ? { rate: pod.cost } : {}) }).where("id", "=", open.id).execute();
        s.sessionFrom = Date.parse(open.started_at);
        return;
      }
      // from when the pod says it started; a deployed pod's first run from its deploy, when the money starts. A start time
      // not after the end of the run before is that run's (RunPod may list it until the new one is under way): this run is
      // counted from its first sight, never from back then (the hours it was stopped, all at once, a cap reached by them)
      const last = await this.db.selectFrom("rent_sessions").select("ended_at").where("machine_id", "=", m.id).where("ended_at", "is not", null).orderBy("ended_at", "desc").executeTakeFirst();
      const lastEnd = last?.ended_at ? Date.parse(last.ended_at) : 0;
      const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
      const said = pod.startedAt ? Date.parse(pod.startedAt) : Number.NaN;
      const started = Number.isFinite(said) && said > lastEnd ? said : now;
      const from = !last && Number.isFinite(deployedAt) ? Math.min(started, deployedAt) : started;
      // its GPU and its idle minutes kept with it: the Costs tab says the one and weighs a shorter idle against the other
      await this.db.insertInto("rent_sessions").values({ id: randomUUID(), machine_id: m.id, pod: pod.id, rate: pod.cost || s.rate || 0, started_at: new Date(Math.min(from, now)).toISOString(), ended_at: null, seen_at: iso, gpu: pod.gpu, up_at: null, idle_minutes: m.rented!.idleMinutes, busy_at: null, volume: pod.volumeId || m.rented!.volume || null }).execute();
      s.sessionFrom = Math.min(from, now);
    } else if (open) {
      // closed now when it was seen running a moment ago. One that ended while Afflatus was away (off, asleep) is closed at
      // the latest it could have run: its watchdog stops it that long after the last "still here" (RunPod's bill, once
      // written, is the reference: spent() takes it)
      // the last sight of it running: a read of RunPod's, or its ComfyUI taking a "still here" while RunPod could not be read
      const seen = Math.max(s.seenRunningAt ?? (open.seen_at ? Date.parse(open.seen_at) : now), s.aliveAt ?? 0);
      const watch = m.rented!.watchdogMinutes;
      const end = now - seen <= AWAY_MS ? now : watch > 0 ? Math.min(now, seen + (watch + 2) * 60_000) : now;
      await this.db.updateTable("rent_sessions").set({ ended_at: new Date(Math.min(end, now)).toISOString() }).where("id", "=", open.id).execute();
      s.seenRunningAt = null;
    }
    if (!(pod && BILLED.has(pod.status))) s.sessionFrom = null;
  }

  /**
   * "Still here" to the pods last seen running, when RunPod itself cannot be read: Afflatus is not silent for that. Only to a
   * pod with work (a job running there), or still within its idle time and short of a cap: one that would be stopped now
   * hears nothing, so that its own watchdog stops it while Afflatus cannot ask RunPod to.
   * The caps and the stuck-render check go on meanwhile, as neither needs RunPod's list: a cap reached during an outage gives
   * the pod no new job (unavailable), and no "still here" past the render it runs, within the hour a cap waits for one.
   */
  private async pingAll(rented: Machine[], caps: { day: number; month: number }): Promise<void> {
    const now = this.now();
    const up = rented.filter((m) => this.seen.get(m.id)?.pod?.status === "RUNNING");
    if (!up.length) return;
    // what was spent counts the open sessions to now, and RunPod's bill as last read: a cap is seen without its list
    const capped = caps.day > 0 || caps.month > 0;
    const spent = capped ? await this.spent().catch((err: Error) => (console.warn(`[rented] spending not read: ${err.message}`), null)) : null;
    if (spent) this.sayCap(caps, spent);
    for (const m of up) {
      const s = this.seen.get(m.id)!;
      // a spending that could not be read leaves the cap as last seen
      if (spent || !capped) {
        s.stopAfter = spent ? capReached(caps, spent) : false;
        s.cappedAt = s.stopAfter ? s.cappedAt ?? now : null;
      }
      await this.endIfStuck(m, now);
      if (s.stopping) continue;
      if (s.stopAfter) {
        // at a cap: kept alive only for the render it runs, as keepOrStop waits for it; not for one waiting in its ComfyUI
        // behind work from outside Afflatus, nor past the hour. Silent otherwise, so that its watchdog stops it
        if (this.queue.runningOn(m.id) && !this.queue.waitingBehindOutside(m.id) && now - s.cappedAt! <= CAP_GRACE_MS) await this.alive(m, s).catch(() => false);
        continue;
      }
      const idle = m.rented!.idleMinutes * 60_000;
      // at work for Afflatus or, as last read, for someone else in its ComfyUI (keepOrStop holds its idle time for that too)
      const keep = this.queue.busyOn(m.id) || idle === 0 || (s.busyAt !== null && now - s.busyAt < idle);
      if (keep) await this.alive(m, s).catch(() => false);
    }
  }

  /**
   * "Still here", to the node pack's watchdog on the pod: it stops the pod by itself when this PC goes silent that long. Says
   * whether its ComfyUI answered as Afflatus's (not while it boots, nor when it went down or is locked against Afflatus's token).
   */
  private async alive(m: Machine, s: Seen): Promise<boolean> {
    const minutes = m.rented!.watchdogMinutes;
    const comfy = await this.comfyOf(m.id);
    if (!comfy) return false;
    // whether ComfyUI answers is its own status: the provider's proxy answers too (a 404 when no container is behind it), and
    // what the watchdog's route answers says only whether the pack is there
    const up = await comfy.client.status().then(() => true, () => false);
    // its ComfyUI answering now and not at the last read (a boot ended, a restart done): the queue plans again at once, the
    // files its jobs wait for asked for. Nothing else tells it when no page is open, and the pod would idle toward its stop
    if (up && s.answers !== true) this.queue.answering(m.id);
    s.answers = up;
    // up again after a death that was acted on, the pod not terminated for it: a pod added by hand, its ComfyUI started again
    if (up && s.comfyDied?.told && s.stoppedBy !== "crash") s.comfyDied = null;
    // its ComfyUI not answering: the pack's watchdog in it is not known to be there either. The Afflatus image on a host whose
    // GPU does not work answers on ComfyUI's port in its place, and says so (deploy/runpod/broken.py)
    if (!up) {
      s.watchdog = "unknown";
      // and the Afflatus image whose ComfyUI died after its start says that, with its numbers (died.py): asked of a pod deployed
      // from here, or of one whose ComfyUI answered before (it may run the image, added by hand)
      if ((m.rented!.deployed || s.answered) && !s.comfyDied) {
        const said = await comfy.client.raw("/afflatus/pod", { signal: AbortSignal.timeout(5_000) })
          .then(async (r) => (r.ok ? ((await r.json()) as { afflatus_pod?: string; error?: string; report?: unknown }) : null), () => null);
        if (m.rented!.deployed && said?.afflatus_pod === "gpu_failed") s.gpuFailed = `Terminated: its GPU did not work on that host (${String(said.error ?? "CUDA error").slice(0, 200)}). Nothing billed after; deploy again, RunPod picks another host.`;
        if (said?.afflatus_pod === "comfy_died") {
          const report = said.report && typeof said.report === "object" && !Array.isArray(said.report) ? (said.report as Record<string, unknown>) : null;
          s.comfyDied = { said: String(said.error || "ComfyUI died").slice(0, 300), report, from: "pod", handled: false, told: false, render: false };
        }
      }
      return false;
    }
    const res = await comfy.client.raw("/afflatus/alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res?.ok) s.aliveAt = this.now();
    // `can` false: the pack has no way to stop this pod; refused (a 404, or a 405 from an older ComfyUI whose page answers every
    // address): no pack, or one without the watchdog
    if (res?.ok) {
      const said = (await res.json().catch(() => null)) as { can?: boolean } | null;
      s.watchdog = minutes > 0 && said?.can ? "on" : "none";
    } else if (res) {
      if (res.status !== 401) s.watchdog = "none";
      await res.body?.cancel().catch(() => {});
    }
    return true;
  }

  /**
   * A render ComfyUI has said nothing of for long, with its GPU idle or past its forecast: failed, so that the pod is free for
   * the next job or its idle time, instead of billed for a render that never ends. At every read, and while RunPod's list
   * cannot be read (pingAll), as it asks nothing of RunPod.
   */
  private async endIfStuck(m: Machine, now: number): Promise<void> {
    const quiet = this.queue.quietFor(m.id, now);
    const why = quiet.gpuIdle ? "its GPU idle" : "past its forecast";
    if (quiet.ms >= this.stuckMs && (await this.queue.endStuck(m.id, `Stuck: no progress from ComfyUI for ${Math.round(quiet.ms / 60_000)} min, ${why}, on the rented GPU ${m.name || m.id}; failed so that the pod is not billed for a render that never ends`))) {
      console.log(`[rented] ${m.name || m.id}: a render stuck for ${Math.round(quiet.ms / 60_000)} min (${why}) failed`);
    }
  }

  /** Idle long enough, or a cap reached once its render ends: stopped (or deleted, as its idle choice says). */
  private async keepOrStop(m: Machine, s: Seen, caps: { day: number; month: number }, answers: boolean): Promise<void> {
    const now = this.now();
    await this.endIfStuck(m, now);
    const running = this.queue.runningOn(m.id);
    // work counts only for a pod whose ComfyUI answers: one that went down would otherwise keep a waiting job "for it" forever
    // not idle before its ComfyUI first answered (a first boot pulling node packs and models): the boot limit covers that.
    // Files coming to it hold it too, while their bytes move (podFiles.ts moving): a pod is never stopped mid-download by its
    // idle stop, and a download stuck for long holds it no more
    // A pod whose last work was read back after a restart keeps it while its ComfyUI does not answer: a fresh idle time
    // given at each restart that found its ComfyUI down was a run billed for nothing
    // the caps first, before anything is asked of its ComfyUI: a slow answer there never holds a cap back
    const spent = await (this.spentThisPoll ??= this.spent());
    this.sayCap(caps, spent);
    s.stopAfter = capReached(caps, spent);
    s.cappedAt = s.stopAfter ? s.cappedAt ?? now : null;
    // at a cap: once its render ends, or an hour after the cap when the render does not end
    // Whether it renders is read again here, the cap now set: a render that ended while the bill was read is not waited for.
    // A render still waiting in its ComfyUI behind work from outside Afflatus has not started: it is not waited for, the pod
    // would bill on for that other work
    if (s.stopAfter && (!this.queue.runningOn(m.id) || this.queue.waitingBehindOutside(m.id) || now - s.cappedAt! > CAP_GRACE_MS)) {
      await this.act(m, this.capAction(m, s.pod), "cap");
      return;
    }
    // Work queued in its ComfyUI from outside Afflatus (its own page, another tool) is work too: the pod is not stopped under
    // it by its idle time. The caps above act all the same
    let outsideRead = false;
    const outside = () => {
      outsideRead = true;
      return this.queue.busyOutside(m.id);
    };
    if (running || (!s.answered && !s.busyRestored) || this.queue.fetching(m.id) || (answers && ((await this.queue.wants(m.id)) || (await outside())))) s.busyAt = now;
    // While its ComfyUI's work from outside Afflatus is being timed (podOutside.ts), its queue is read at every pass all the
    // same, Afflatus's own work there or not: the stretch is kept to this pass's sight of it, not closed early at an older one
    if (answers && !outsideRead && this.outsideTimed(m.id)) await this.queue.busyOutside(m.id);
    // set when it was first seen running (follow), from what was kept across a restart of Afflatus
    s.busyAt ??= now;
    await this.keepBusy(m, s);
    const idle = m.rented!.idleMinutes * 60_000;
    if (idle > 0 && now - s.busyAt >= idle) await this.act(m, m.rented!.idleDo, "idle");
  }

  /**
   * What a cap does to a pod: it stops it, or terminates one that a stop would leave with nothing worth keeping: a fill pod
   * (stopped, it would keep its volume mounted, never deleted then, and fill nothing), and a pod Afflatus deployed that keeps
   * nothing when stopped (no volume of any kind: a stop would only have it found stopped and terminated after, told of as
   * its watchdog's), that is still on its first boot (its deploy is what it was for), or whose deploy said to terminate it
   * when idle. That last one was only stopped on a network volume before: stopped, its container disk went on billing until
   * removed by hand, and the network volume outlives a terminate anyway. A pod the user added is only stopped.
   */
  private capAction(m: Machine, pod: Pod | null): "stop" | "terminate" {
    const keeps = Boolean(pod && (pod.networkVolume || pod.diskGb > 0));
    return m.rented!.fill || (m.rented!.deployed && (!keeps || Boolean(m.rented!.deployedAt) || m.rented!.idleDo === "terminate")) ? "terminate" : "stop";
  }

  /**
   * When a pod last had work, as kept when Afflatus was not following it (a restart): the latest of what its open session
   * kept, its boot's end (or the session's start before that), and the end of the last job it ran. Now when nothing says.
   */
  private async busySince(m: Machine, now: number): Promise<{ at: number; restored: boolean }> {
    const open = await this.db.selectFrom("rent_sessions").select(["started_at", "up_at", "busy_at"]).where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    if (!open) return { at: now, restored: false };
    const job = await this.db.selectFrom("jobs").select((eb) => eb.fn.max("finished_at").as("at")).where("machine_id", "=", m.id).executeTakeFirst();
    const times = [open.busy_at, open.up_at ?? open.started_at, job?.at ?? null].map((t) => (t ? Date.parse(t) : Number.NaN)).filter(Number.isFinite);
    // its boot was over: its session kept where its ComfyUI first answered, or a deployed pod's first answer cleared its
    // deploy's mark. A pod still booting (a deploy never answered) keeps its boot limit and its not-answered rule
    const answeredOnce = Boolean(open.up_at) || (Boolean(m.rented!.deployed) && !m.rented!.deployedAt);
    return { at: times.length ? Math.min(now, Math.max(...times)) : now, restored: Boolean(open.busy_at) && answeredOnce };
  }

  /** When it last had work, written on its open session as it moves: what a restart of Afflatus reads back (busySince). */
  private async keepBusy(m: Machine, s: Seen): Promise<void> {
    if (s.busyAt === null || s.busyAt === s.busyKept) return;
    await this.db.updateTable("rent_sessions").set({ busy_at: new Date(s.busyAt).toISOString() }).where("machine_id", "=", m.id).where("ended_at", "is", null).execute();
    s.busyKept = s.busyAt;
  }

  /** A pod Afflatus stopped or terminated on its own: why, and what its run cost. */
  private async sayStopped(m: Machine, s: Seen, action: "stop" | "terminate", why: Exclude<NonNullable<RentedView["stoppedBy"]>, "you">): Promise<void> {
    if (!this.tell) return;
    const because: Record<typeof why, string> = {
      idle: `idle ${m.rented!.idleMinutes} min`,
      cap: "a spending cap was reached",
      boot: `its ComfyUI never answered in ${bootLimit(m) / 60_000} min`,
      gpu: "its GPU did not work on that host",
      start: `its start failed: ${stepSaid(this.boots.get(m.id)?.failed ?? "see its log")}`,
      crash: `${s.comfyDied?.said ?? "its ComfyUI died"}${s.comfyDied?.render ? "; its render failed, not run again" : ""}`,
      watchdog: "its watchdog had stopped it while Afflatus was away, and it kept nothing",
      filled: "its volume is filled",
      cut: `its fill was cut short: ${s.cutWhy ?? "it stopped moving"}`,
    };
    const cost = await this.lastRunCost(m);
    this.tell("podStopped", { title: `${machineSaid(m)} ${action === "terminate" ? "terminated" : "stopped"}`, body: `Why: ${because[why]}.${cost !== null ? ` This run: ${dollars(cost)}.` : ""}`, key: `${m.id}:${why}` });
  }

  /**
   * A machine whose pod is gone (terminated) taken out of Afflatus: its secret, when it could not be deleted on RunPod, kept
   * on the list of secrets to delete (sweepSecrets), never left on the account.
   */
  protected async forget(m: Machine, s: Seen): Promise<void> {
    await updateSettings(this.db, (current) => ({
      machines: current.machines.filter((x) => x.id !== m.id),
      ...(s.secretDropped ? {} : { leftSecrets: [...current.leftSecrets.filter((l) => l.pod !== m.rented!.pod), { secret: secretOf(m), pod: m.rented!.pod }] }),
    }));
    this.seen.delete(m.id);
    this.boots.forget(m.id);
    // what it was getting goes with it now: once its machine is out, nothing reads it as down any more
    this.forgetFiles?.(m.id);
    this.events.emit("setup");
  }

  /** `again`: a stop asked again of a pod still running after the first (told of once, at the first). */
  protected async act(m: Machine, action: "start" | "stop" | "terminate", why: RentedView["stoppedBy"], again = false): Promise<void> {
    const s = this.seenOf(m.id);
    // what a fill cut short still waited for, read before its pod goes (podFiles forgets a pod being stopped)
    const fillLeft = action === "terminate" && m.rented!.fill && why !== "filled" ? this.filesLeft?.(m.id) ?? null : undefined;
    // a read under way is not taken over this, and a stopping pod takes no new work from now (asked again: no second stop)
    s.epoch++;
    // a start is not a stop under way any more
    if (action === "start") {
      s.stopping = false;
      s.stoppingSince = null;
      s.stopAction = null;
      s.comfyDied = null;
      // its boot log is this start's from now: the last one's lines are not where this one is
      this.boots.forget(m.id);
    }
    if (action !== "start") {
      if (s.stopping && why !== "you") return;
      s.stopping = true;
      s.stopAction = action;
      // a job the queue started on it a moment ago: idle and cap stops wait for it (the user's own Stop does not, nor a crash:
      // its render is being failed, and its ComfyUI is dead)
      if (why !== "you" && why !== "cap" && why !== "crash" && this.queue.runningOn(m.id)) {
        s.stopping = false;
        return;
      }
    }
    this.events.emit("queue");
    const settings = await readSettings(this.db);
    if (!settings.runpodKey) {
      s.stopping = false;
      throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    }
    let after: Pod | null;
    try {
      after = await this.client(settings.runpodKey).act(m.rented!.pod, action);
    } catch (err) {
      s.stopping = false;
      s.epoch++;
      const status = (err as RunpodError).status;
      if (status === 429) this.quietUntil = this.now() + BACK_OFF_MS;
      throw httpError((err as Error).message, status === 409 ? 409 : 502);
    }
    s.pod = action === "terminate" ? null : after ?? s.pod;
    // terminated, whoever asked: its secret goes too (nothing left on RunPod that was the pod's)
    if (action === "terminate") await this.dropSecret(m, s, settings.runpodKey);
    // a fill ended before its files were in says so with its volume, never "all in"
    if (fillLeft !== undefined) await this.noteCut(m, s, why, fillLeft);
    // one that never came up keeps its card (which says why), but no longer holds its volume as starting on it
    if (action === "terminate" && (why === "boot" || why === "gpu" || why === "start")) await this.undeploy(m);
    s.stoppedBy = action === "start" ? null : why;
    s.error = null;
    // why its run ended, on its session before it is closed (Costs, past a restart of Afflatus)
    if (action !== "start" && why) await this.db.updateTable("rent_sessions").set({ end_why: why }).where("machine_id", "=", m.id).where("ended_at", "is", null).execute().catch(() => {});
    // the user's own stop, kept with the machine (read again after a restart of Afflatus); any start ends it
    const userStopped = action === "stop" && why === "you";
    if (action !== "terminate" && Boolean(m.rented!.userStopped) !== userStopped) {
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, userStopped } } : x)) }));
    }
    if (action !== "start") {
      s.busyAt = null;
      s.busyKept = null;
      // a pod a cap stops while it starts is followed as being stopped too (asked again if it does not)
      s.stopping = s.pod?.status === "RUNNING" || (why === "cap" && TRANSITIONAL.has(s.pod?.status ?? ""));
      s.stoppingSince = s.stopping ? this.now() : null;
      await this.session(m, s.pod, s);
    }
    // a deployed pod terminated by its idle time, a cap or a boot that never came: nothing is left of it, its machine goes too
    // (the user's own Terminate removes it in stopBy)
    if (action === "terminate" && m.rented!.deployed && (why === "idle" || why === "cap" || why === "watchdog" || why === "filled" || why === "cut")) await this.forget(m, s);
    // told when Afflatus stopped it on its own, never for the user's own Stop
    if (action !== "start" && why && why !== "you" && !again) await this.sayStopped(m, s, action, why).catch((err: Error) => console.warn(`[rented] its stop not told: ${err.message}`));
    if (why === "filled") console.log(`[rented] ${m.name || m.id}: its volume filled, terminated`);
    if (why === "watchdog") console.log(`[rented] ${m.name || m.id}: found stopped by its watchdog, terminated (it kept nothing)`);
    if (why === "start") console.log(`[rented] ${m.name || m.id}: terminated (its start stopped: ${this.boots.get(m.id)?.failed ?? "an error"})`);
    if (why === "crash") console.log(`[rented] ${m.name || m.id}: terminated (${s.comfyDied?.said ?? "its ComfyUI died"})`);
    if (why === "idle" || why === "cap" || why === "boot" || why === "gpu") console.log(`[rented] ${m.name || m.id}: ${action === "terminate" ? "terminated" : "stopped"} (${why === "idle" ? `idle ${m.rented!.idleMinutes} min` : why === "boot" ? `its ComfyUI never answered in ${bootLimit(m) / 60_000} min` : why === "gpu" ? "its GPU did not work on that host" : "a spending cap"})`);
    this.events.emit("queue");
    // read again soon, then at the fast pace while it moves
    this.kick(1500);
  }
}
