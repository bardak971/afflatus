import { plural, tooOldSaid, type ComfyTooOld } from "@afflatus/core";
import { z } from "zod";
import { costsOf } from "./costs-api";
import { deployFiles } from "./deployModels";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { machineName, machineOf, seen } from "./mcpForms";
import { committedSpend, mustNotSteerOntoPods, podsTaking, podsUp, workCommitted } from "./mcpRender";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { refusal, type McpToken } from "./mcpTokens";
import { dollars } from "./notifyWords";
import { runningRate } from "./runpod";
import type { Services } from "./services";
import { deploySchema, readSettings, type Machine } from "./settings";
import { machinesNow, saveSettings, setupOf } from "./setup-api";

/**
 * The machines and the rented GPUs, from outside (MCP): the ComfyUIs listed, changed, removed and asked again (Settings ›
 * ComfyUI), and the pods of RunPod deployed, started, stopped or terminated, with what they cost (Settings › Rented GPUs,
 * Queue › Costs). Each goes through the route's own code (setup-api.ts, rented.ts), with the same refusals. A machine is
 * never added, nor its address changed, from here (owner, 2026-10-27: "only in Afflatus"): every later render sends its
 * prompts, pictures and cast faces to that address.
 *
 * A money path (memory money-paths-critical). What starts a pod (deploy_pod, start_pod) needs Spend, and is refused when
 * the token's own cap or the app's caps have no room for the pod's first hour at its price, with the next hour of every pod
 * already up counted (the token's own against its cap, all of them against the app's) and its waiting and running work
 * counted as render counts it. The run it starts is then the token's (rentedSchema.mcpToken): its whole time, boot and
 * idle included, counts against the token's cap (mcpTokens.ts spentThisMonth), and the pod stops once that cap is reached
 * as at the app's caps (rentedFollow.ts tokenCapped). An agent's pod always has an idle stop and a watchdog: neither is
 * set to "never" from here, and a pod set to never is not started from here. A pod's idle rule and watchdog need Spend,
 * and so does what steers work onto a pod that is up (what a machine takes, its families, removing a machine of the
 * user's own). Stop and Terminate need Spend (the rented GPUs are its scope), and a pod running a render this token did
 * not send is not stopped from here. A token's checks and its starts go one call at a time, with its renders
 * (`mcp-render:<token>`).
 */

/** Whether this token has Spend: what starts a rented GPU, lengthens its run or stops it needs it. */
function mustSpend(ctx: Pick<ToolCtx, "token">, what: string): void {
  if (!ctx.token.scopes.includes("spend")) throw refusal(`This token cannot spend on rented GPUs, and ${what}: tick Spend on it in Settings › Agents (MCP).`);
}

/** A machine as the tools say it: never its token, its folder on this computer, nor figures of its card's memory. */
function machineSaid(s: Services, m: Machine, now?: { online: boolean; error: string | null; version: string | null; pytorch?: string | null; tooOld?: ComfyTooOld | null; device: string | null; pack: string | null }, paused?: boolean) {
  const v = m.rented ? s.rented.view(m) : null;
  return {
    id: m.id, name: machineName(m), kind: m.rented ? "rented pod" : "ComfyUI",
    ...(m.rented ? {} : { url: m.url }),
    takes: m.takes,
    ...(m.rented ? {} : { nodePacks: m.packs }),
    ...(Object.keys(m.families).length ? { families: m.families } : {}),
    ...(now ? { online: now.online, ...(now.error ? { error: now.error } : {}), ...(now.version ? { comfyui: now.version } : {}), ...(now.pytorch ? { pytorch: now.pytorch } : {}), ...(now.tooOld ? { tooOldFor: { needs: now.tooOld.needs, families: tooOldSaid(now.tooOld) } } : {}), ...(now.device ? { gpu: now.device } : {}), ...(now.pack ? { nodePack: now.pack } : {}) } : {}),
    ...(paused !== undefined ? { paused } : {}),
    ...(m.rented ? { pod: podSaid(m, v) } : {}),
  };
}

/** A pod as the tools say it: its state on RunPod, its price, what this run cost, its idle rule, whose run it is. */
function podSaid(m: Machine, v: ReturnType<Services["rented"]["view"]>) {
  const r = m.rented!;
  return {
    pod: r.pod, status: v?.status ?? "UNKNOWN", gpu: v?.gpu ?? null, usdPerHour: v?.rate ?? null,
    ...(v?.since ? { runningSince: new Date(v.since).toISOString(), spentThisRun: Math.round(v.spent * 100) / 100 } : {}),
    ...(v?.answers !== null && v?.answers !== undefined ? { comfyAnswers: v.answers } : {}),
    ...(v?.idleLeftMs ? { stopsIdleInMs: v.idleLeftMs } : {}),
    ...(v?.capped ? { capped: true } : {}),
    ...(v?.stopping ? { stopping: true } : {}),
    idleMinutes: r.idleMinutes, idleDo: r.idleDo, watchdogMinutes: r.watchdogMinutes, volume: Boolean(v?.volume),
    ...(r.mcpToken ? { startedByToken: r.mcpToken } : {}),
  };
}

const listMachines = tool({
  name: "list_machines",
  scope: "look",
  title: "Machines",
  description: "Every ComfyUI the queue sends work to (this PC's, another computer's, rented pods), asked now: whether it answers and why not, its ComfyUI version and PyTorch (and the families that version is too old for, with the version they need), GPU and Afflatus node pack, what it takes (everything, pictures or videos), paused or not, its families switched by hand; a pod's state on RunPod, price, this run's cost and idle rule.",
  async run(_args, ctx) {
    const { s } = ctx;
    const [settings, now, st] = await Promise.all([readSettings(s.db), machinesNow(s), s.queue.statusRecent()]);
    ctx.said(`Looked at the machines: ${settings.machines.length}`);
    return {
      machines: settings.machines.map((m) => machineSaid(s, m, now.find((n) => n.id === m.id), st.machines.find((x) => x.id === m.id)?.paused)),
      queuePaused: st.paused,
    };
  },
});

const editMachine = tool({
  name: "edit_machine",
  scope: "manage",
  title: "Change a machine",
  description: "Change a machine as its card in Settings › ComfyUI does: its name, what it takes, its families switched on or off on it alone; a pod's idle minutes, what it does then (stop: its disk billed on; terminate: deleted on RunPod), its watchdog and Make room. A pod's idle rule and watchdog need Spend, and are never set to 0 (never) from here; on a pod this token did not start they are only shortened (fewer minutes, stop → terminate); what it takes and its families, while a rented pod takes work, are refused unless that pod is one this token started (and then need Spend): work would move onto it with no cap counting it. A machine's address, adding a machine, node packs installed without asking, open ports and its folder on this computer are the user's, in Afflatus itself.",
  input: {
    machine: z.string().min(1).describe("A machine's id or name (list_machines)."),
    name: z.string().trim().max(40).optional(),
    takes: z.enum(["all", "image", "video"]).optional(),
    families: z.record(z.string().max(120), z.boolean().nullable()).optional().describe("Family id → on or off on this machine alone; null: back to the switch of every machine."),
    idleMinutes: z.number().int().min(1).max(24 * 60).optional().describe("A pod: minutes with nothing to render, then idleDo."),
    idleDo: z.enum(["stop", "terminate"]).optional(),
    watchdogMinutes: z.number().int().min(1).max(24 * 60).optional().describe("A pod: minutes this PC may be silent before the pod stops itself."),
    makeRoom: z.boolean().optional().describe("A pod: models it fetched that no waiting job needs are deleted when a file does not fit."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const settings = await readSettings(s.db);
    const m = machineOf(await seen(s), a.machine);
    const podOnly = a.idleMinutes !== undefined || a.idleDo !== undefined || a.watchdogMinutes !== undefined || a.makeRoom !== undefined;
    if (podOnly && !m.rented) throw httpError(`${machineName(m)} is not a rented pod: idle minutes, idle action, watchdog and Make room are a pod's.`);
    // a pod's idle rule and watchdog are Spend's, as starting one is
    const podRule = a.idleMinutes !== undefined || a.idleDo !== undefined || a.watchdogMinutes !== undefined;
    if (podRule) mustSpend(ctx, `a pod's idle time, idle action and watchdog decide how long ${machineName(m)} bills`);
    // on a pod this token did not start, its run is not counted against this token's cap: only shortened from here, as
    // change_setting lowers the app's caps but never raises them (card #182)
    if (podRule && m.rented!.mcpToken !== ctx.token.id) {
      // 0 is never: any minutes are shorter than that
      const longerThan = (asked: number | undefined, was: number) => asked !== undefined && was > 0 && asked > was;
      const longer = [
        longerThan(a.idleMinutes, m.rented!.idleMinutes) ? `idle minutes ${m.rented!.idleMinutes} → ${a.idleMinutes}` : "",
        longerThan(a.watchdogMinutes, m.rented!.watchdogMinutes) ? `watchdog ${m.rented!.watchdogMinutes} → ${a.watchdogMinutes} min` : "",
        a.idleDo === "stop" && m.rented!.idleDo === "terminate" ? "idle action terminate → stop (its disk billed on)" : "",
      ].filter(Boolean);
      if (longer.length) throw refusal(`${quoted(machineName(m))} is ${m.rented!.mcpToken ? "a pod another token started" : "the user's pod"}: its bill is not counted against this token's cap, so from here it is only made to bill less (${longer.join(", ")} refused). The user lengthens it in Afflatus.`);
    }
    // what a machine takes, and its families, steer the queue's work: onto a pod that is up, that is spending
    if (a.takes !== undefined || a.families !== undefined) mustNotSteerOntoPods(ctx, await podsTaking(s, settings.machines), `changing what ${machineName(m)} takes`);
    const families = a.families ? Object.fromEntries(Object.entries({ ...m.families, ...a.families }).filter((e): e is [string, boolean] => e[1] !== null)) : m.families;
    // a rented machine's own fields the page would send: the server keeps the rest of it (settings.ts written, fromPage)
    const rented = m.rented ? { idleMinutes: a.idleMinutes ?? m.rented.idleMinutes, idleDo: a.idleDo ?? m.rented.idleDo, watchdogMinutes: a.watchdogMinutes ?? m.rented.watchdogMinutes, openPorts: m.rented.openPorts, makeRoom: a.makeRoom ?? m.rented.makeRoom } : undefined;
    const next = settings.machines.map((x) => (x.id === m.id ? { ...x, token: undefined, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.takes ? { takes: a.takes } : {}), families, ...(rented ? { rented } : {}) } : { ...x, token: undefined }));
    await saveSettings(s, { machines: next }, { session: null, password: undefined, ip: ctx.ip });
    const changed = Object.keys(a).filter((k) => k !== "machine");
    ctx.said(`Changed ${quoted(machineName(m))}: ${changed.join(", ") || "nothing"}`);
    const saved = (await readSettings(s.db)).machines.find((x) => x.id === m.id)!;
    return machineSaid(s, saved);
  },
});

const removeMachine = tool({
  name: "remove_machine",
  scope: "manage",
  title: "Remove a machine",
  description: "Take a machine out of Afflatus, as its card's Remove does: nothing more is sent there. A pod still billed on RunPod is refused (stop_pod first); a pod stopped is left on RunPod as it is. The last machine is refused. Removing a machine of the user's own while a rented pod takes work is refused unless that pod is one this token started (and then needs Spend): its work would go to the pod with no cap counting it. A machine taken out is added again by the user, in Afflatus.",
  input: { machine: z.string().min(1).describe("A machine's id or name (list_machines).") },
  async run({ machine }, ctx) {
    const at = await seen(ctx.s);
    const m = machineOf(at, machine);
    if (!m.rented) mustNotSteerOntoPods(ctx, await podsTaking(ctx.s, at.machines.map((x) => x.machine)), `removing ${machineName(m)}`);
    await ctx.s.rented.remove(m.id);
    ctx.said(`Removed ${quoted(machineName(m))}`);
    return { removed: m.id, ...(m.rented ? { said: "Its pod is left on RunPod as it is: terminate it there, or add it again in Afflatus." } : {}) };
  },
});

const reconnect = tool({
  name: "reconnect",
  scope: "make",
  title: "Reconnect",
  description: "Ask a ComfyUI (or every one) afresh what it has, as the queue's Reconnect does: a model or node pack put in by hand, a ComfyUI restarted, is seen now, and a job that waited for it may start. Answers whether each answers.",
  input: { machine: z.string().optional().describe("A machine's id or name (list_machines); left out, every one.") },
  async run({ machine }, ctx) {
    const { s } = ctx;
    const m = machine ? machineOf(await seen(s), machine) : undefined;
    const fresh = await setupOf(s, m?.id, true);
    s.queue.events.emit("setup");
    ctx.said(m ? `Asked ${quoted(machineName(m))} again` : "Asked every ComfyUI again");
    return fresh.comfy.online ? { online: true } : { online: false, error: fresh.comfy.error };
  },
});

// ---------------------------------------------------------------- rented GPUs

const pods = tool({
  name: "pods",
  scope: "look",
  title: "Rented GPUs",
  description: "The rented pods Afflatus follows: each one's state on RunPod, price, this run's cost, time left before its idle stop, idle rule, and the token that started its run. `gpus`: the GPUs deploy_pod may take now on that cloud, with their price an hour and whether they are free. `account`: every pod of the RunPod account, added or not (the user adds one in Afflatus).",
  input: {
    gpus: z.enum(["SECURE", "COMMUNITY"]).optional().describe("List the GPUs offered now on this cloud."),
    account: z.boolean().optional().describe("List every pod of the RunPod account too."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const settings = await readSettings(s.db);
    const followed = settings.machines.filter((m) => m.rented);
    const offers = a.gpus ? await s.rented.gpus(a.gpus) : null;
    const account = a.account ? await s.rented.pods() : null;
    ctx.said(`Looked at the rented GPUs: ${plural(followed.length, "pod")}${offers ? `, ${offers.length} GPUs offered` : ""}`);
    return {
      pods: followed.map((m) => ({ id: m.id, name: machineName(m), ...podSaid(m, s.rented.view(m)) })),
      ...(offers ? { gpus: offers.map((g) => ({ id: g.id, name: g.name, usdPerHour: g.price, free: g.availability, cuda13: g.cuda13 })).sort((x, y) => x.usdPerHour - y.usdPerHour) } : {}),
      ...(account ? { account: account.map((p) => ({ pod: p.id, name: p.name, status: p.status, gpu: p.gpu, usdPerHour: p.cost || null, comfyPort: p.comfy, added: p.added })) } : {}),
      ...(settings.runpodKey ? {} : { said: "No RunPod API key is set: the user sets it in Settings › Rented GPUs." }),
    };
  },
});

/**
 * Whether this token may start a pod that bills `hour` USD an hour: Spend, its own cap with room for that first hour and
 * the next hour of each pod it started that is up (its work waiting and running counted, as render counts it), and the
 * app's caps with room for that first hour and the next hour of every pod up. A pod up whose price is not known yet cannot
 * be counted: refused. A money path. `what` says the bill to a token without Spend, `pod` names it in a cap's refusal. The
 * GPU hunt asks it too (start_hunt at its ceiling, and again at its deploy, hunt.ts mayDeploy, with the token as read then).
 */
export async function mayStart(s: Services, token: McpToken, hour: number, what: string, pod: string): Promise<void> {
  // a token revoked or ended since (a hunt it started deploys later) spends nothing more: as /mcp refuses it (mcpTokens.ts byBearer)
  if (token.revokedAt || (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())) throw refusal(`The MCP token ${quoted(token.name)} is ${token.revokedAt ? "revoked" : "ended"}: it spends nothing more.`);
  const ctx = { token };
  mustSpend(ctx, what);
  const machines = (await readSettings(s.db)).machines;
  let mine = 0;
  let all = 0;
  // each pod up and its next hour, named in a refusal: the sum the cap was asked is then seen, not only what was spent
  const minePods: Array<{ what: string; usd: number }> = [];
  const allPods: string[] = [];
  for (const pod of podsUp(s, machines)) {
    const rate = s.rented.view(pod)?.rate;
    if (rate === null || rate === undefined) throw refusal(`${machineName(pod)} is up and its price is not known yet, so the spending caps cannot be held: wait until it answers, or the user starts this one in Afflatus.`);
    all += rate;
    allPods.push(`${quoted(machineName(pod))} ${dollars(rate)}`);
    if (pod.rented!.mcpToken === ctx.token.id) {
      mine += rate;
      minePods.push({ what: `the next hour of ${quoted(machineName(pod))}, up (started by this token)`, usd: rate });
    }
  }
  const work = await committedSpend(s, machines, ctx.token.id);
  await s.mcp.tokens.maySpend(token, hour + mine + work.usd, { committed: [...workCommitted(work), ...minePods], adds: { what: `the first hour of ${pod}`, usd: hour } });
  const why = await s.rented.noRoomFor(hour + all);
  if (why) throw refusal(`The rented GPUs' spending cap has no room for this pod's first hour (${dollars(hour)}${all ? `, with the next hour of the pods up: ${dollars(all)}` : ""}): ${why}.${allPods.length ? ` Up: ${allPods.join(", ")} an hour.` : ""} The user raises it in Settings › Costs.`);
}

/**
 * The GPU hunt's check before it deploys for an MCP token (hunt.ts mayDeploy): mayStart with the token as it is now, the
 * pod's price as the hunt found it. A token gone is refused: nothing is billed for a token nobody can see.
 */
export async function huntMayDeploy(s: Services, tokenId: string, hour: number, gpu: string): Promise<void> {
  const token = await s.mcp.tokens.get(tokenId);
  if (!token) throw refusal("The MCP token that started the hunt is gone: it spends nothing more.");
  await mayStart(s, token, hour, `deploying ${gpu} bills ${dollars(hour)} an hour`, `a new ${quoted(gpu)}`);
}

const deployPod = tool({
  name: "deploy_pod",
  scope: "spend",
  title: "Deploy a GPU",
  description: "Deploy a new pod on RunPod, as Settings › Rented GPUs › Deploy does: billed from now. The choices the dialog gives, the last deploy's when left out: the GPU (pods with gpus lists them with their price), Secure or Community cloud, Afflatus's image or RunPod's ComfyUI, a network volume, its disk, its idle minutes and what it does then (terminate by default here), its watchdog, a Model set whose files it fetches (a preset under a licence must have been accepted in Afflatus first). Refused when this token's cap or the app's caps have no room for its first hour; the pod's whole run then counts against this token's cap, and it stops once that cap is reached. Afflatus's own rules hold: one deploy at a time, a GPU free now, at most 12 machines.",
  input: {
    gpu: z.string().min(1).max(120).describe("The GPU's id or name, as pods with gpus lists them."),
    cloud: z.enum(["SECURE", "COMMUNITY"]).optional(),
    template: z.enum(["afflatus", "runpod"]).optional().describe("afflatus: ComfyUI with Afflatus's node pack, locked from its first second; runpod: RunPod's own ComfyUI image."),
    volume: z.string().max(80).optional().describe("A network volume's id; empty: none."),
    disk: z.number().int().min(20).max(2000).optional().describe("Its container disk, GB."),
    idleMinutes: z.number().int().min(1).max(120).optional().describe("Minutes with nothing to render, then idleDo (3 when left out)."),
    idleDo: z.enum(["stop", "terminate"]).optional().describe("terminate when left out: nothing billed after; stop keeps its disk (with a volume only), billed."),
    watchdogMinutes: z.number().int().min(1).max(120).optional().describe("Minutes this PC may be silent before the pod stops itself."),
    set: z.string().max(80).optional().describe("A Model set's id (model_sets): its files are fetched onto it."),
    cuda: z.enum(["13.0", "12.8", "either"]).optional(),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    if (s.hunt.deploying()) throw httpError("The GPU hunt is deploying a GPU now: wait for it to end.", 409);
    const settings = await readSettings(s.db);
    const last = settings.lastDeploy;
    const cloud = a.cloud ?? last?.cloud ?? "SECURE";
    const offers = await s.rented.gpus(cloud);
    const offer = offers.find((g) => g.id === a.gpu) ?? offers.find((g) => g.name.toLowerCase() === a.gpu.toLowerCase());
    if (!offer) throw httpError(`RunPod does not offer ${a.gpu} on ${cloud === "COMMUNITY" ? "Community" : "Secure"} Cloud now: pods with gpus lists those it does.`, 404);
    const ask = deploySchema.parse({
      ...(last ?? {}), gpu: offer.id, cloud,
      ...(a.template ? { template: a.template } : {}), ...(a.volume !== undefined ? { volume: a.volume } : {}), ...(a.disk ? { disk: a.disk } : {}),
      idleMinutes: a.idleMinutes ?? 3, idleDo: a.idleDo ?? "terminate", watchdogMinutes: a.watchdogMinutes ?? Math.min(last?.watchdogMinutes || 15, 120),
      set: a.set ?? "", ...(a.cuda ? { cuda: a.cuda } : {}),
      // the set's files come as Deploy again brings them; nothing ticked by hand, no licence accepted from here
      files: [], leaveOut: [], accept: [], again: Boolean(a.set), cudaOnce: false,
    });
    // what it bills an hour while it runs: its GPU and its container disk (with a volume, the disk is kept small: rentedDeploy.ts)
    const hour = runningRate(offer.price, ask.volume ? Math.min(ask.disk, 40) : ask.disk, 0);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      await mayStart(s, token, hour, `deploying ${offer.name} bills ${dollars(hour)} an hour`, `a new ${quoted(offer.name)}`);
      const made = await s.rented.deploy(async () => ({ ...ask, files: await deployFiles(s, ask) }), { mcpToken: token.id });
      ctx.said(`Deployed ${quoted(offer.name)} (${dollars(hour)}/h, idle ${ask.idleMinutes} min then ${ask.idleDo})`);
      return {
        machine: made.id, gpu: offer.name, usdPerHour: Math.round(hour * 1000) / 1000, dataCenter: made.dataCenter, idleMinutes: ask.idleMinutes, idleDo: ask.idleDo,
        said: `Billed from now. Its first start pulls its image and boots ComfyUI (some minutes): pods says when it answers. Its whole run counts against this token's cap (${dollars(token.spendCapCents / 100)} a month), and it stops once that is reached.`,
      };
    });
  },
  // followed until its ComfyUI answers, or it stops before
  task: (a: { machine: string }) => ({ pod: a.machine }),
});

/** A rented machine by id or name: refused for a ComfyUI of the user's own. */
async function podOf(s: Services, asked: string): Promise<Machine> {
  const m = machineOf(await seen(s), asked);
  if (!m.rented) throw httpError(`${machineName(m)} is not a rented pod.`, 404);
  return m;
}

const startPod = tool({
  name: "start_pod",
  scope: "spend",
  title: "Start a pod",
  description: "Start a stopped pod, as its card's Start does: billed from now. Refused when this token's cap or the app's caps have no room for its first hour at its last price (with the next hour of the pods already up), and for a pod whose idle stop or watchdog is set to never (edit_machine sets them); its run then counts against this token's cap, and it stops once that cap is reached (or at its idle stop).",
  input: { machine: z.string().min(1).describe("The pod's machine id or name (pods).") },
  async run({ machine }, ctx) {
    const { s, token } = ctx;
    const m = await podOf(s, machine);
    // an agent's pod always has an idle stop and a watchdog: one set to never would bill on with nobody to stop it
    if (m.rented!.idleMinutes <= 0 || m.rented!.watchdogMinutes <= 0) throw refusal(`${machineName(m)} is set to ${m.rented!.idleMinutes <= 0 ? "never stop when idle" : "run without a watchdog"}: give it an idle stop and a watchdog (edit_machine) before it is started from here, or the user starts it in Afflatus.`);
    const v = s.rented.view(m);
    // a pod never seen running here has no price to hold a cap with: started in Afflatus itself, not from here
    if (v?.rate === null || v?.rate === undefined) throw refusal(`${machineName(m)}'s price is not known yet, so this token's spend cap cannot be held: the user starts it in Afflatus.`);
    const rate = v.rate;
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      await mayStart(s, token, rate, `starting ${machineName(m)} bills ${dollars(rate)} an hour`, quoted(machineName(m)));
      const view = await s.rented.start(m.id, token.id);
      ctx.said(`Started ${quoted(machineName(m))} (${dollars(rate)}/h)`);
      return { started: m.id, status: view.status, usdPerHour: rate, idleMinutes: m.rented!.idleMinutes, idleDo: m.rented!.idleDo, said: "Billed from now; its run counts against this token's cap." };
    });
  },
});

const stopPod = tool({
  name: "stop_pod",
  scope: "spend",
  title: "Stop or terminate a pod",
  description: "Stop a pod (its GPU stops billing; its disk goes on billing and it can be started again) or terminate it (deleted on RunPod with its container disk, nothing billed after, and gone from Afflatus; a network volume keeps what it holds). Refused while it renders something this token did not send: that render is the user's (or another token's) to stop.",
  input: {
    machine: z.string().min(1).describe("The pod's machine id or name (pods)."),
    how: z.enum(["stop", "terminate"]),
  },
  async run({ machine, how }, ctx) {
    const { s, token } = ctx;
    const m = await podOf(s, machine);
    const running = (await s.queue.statusRecent()).machines.find((x) => x.id === m.id)?.running as { id: string; label: string } | null | undefined;
    if (running) {
      const row = await s.db.selectFrom("jobs").select("mcp_token_id").where("id", "=", running.id).executeTakeFirst();
      if (row?.mcp_token_id !== token.id) throw refusal(`${machineName(m)} is rendering “${running.label}”, which this token did not send: the user stops it in Afflatus, or it stops at its idle time once that render ends.`);
    }
    await s.rented.stopBy(m.id, how);
    ctx.said(`${how === "terminate" ? "Terminated" : "Stopped"} ${quoted(machineName(m))}`);
    return how === "terminate"
      ? { terminated: m.id, said: "Deleted on RunPod: nothing more is billed for it, and it is gone from Afflatus. This is not undone." }
      : { stopped: m.id, said: "Its GPU no longer bills; its disk goes on billing until it is terminated. start_pod starts it again." };
  },
});

const costsTool = tool({
  name: "costs",
  scope: "look",
  title: "Costs",
  description: "Queue › Costs: what the rented GPUs cost this month (RunPod's bill where read) and today, against the caps; the pace a day and the month's end at it; RunPod's balance and how long it lasts; where the pods' time went (rendering, idle, booting, fetching files); the costliest projects; the newest pod runs, each with its GPU, length, cost and why it ended; and advice. A window in ms (from, to), else everything.",
  input: {
    from: z.number().int().optional().describe("The window's start, ms since 1970."),
    to: z.number().int().optional(),
    runs: z.number().int().min(0).max(50).optional().describe("How many of the newest pod runs to list (8 when left out)."),
  },
  async run(a, ctx) {
    const { view: v } = await costsOf(ctx.s, { from: a.from, to: a.to });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    ctx.said(`Looked at the costs: ${dollars(v.month)} this month`);
    return {
      window: { from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString() },
      billedByRunpod: v.billed,
      month: r2(v.month), today: r2(v.today.usd), caps: v.caps,
      pacePerDay: r2(v.pace7 + v.storageDay), monthEndAtPace: r2(v.monthEnd),
      balance: v.balance === null ? null : r2(v.balance), runwayDays: v.runwayDays === null ? null : Math.round(v.runwayDays * 10) / 10,
      podTime: Object.fromEntries(Object.entries(v.where.usd).map(([k, usd]) => [k, { usd: r2(usd), ms: v.where.ms[k as keyof typeof v.where.ms] }])),
      projects: v.projects.slice(0, 8).map((p) => ({ name: p.name, usd: r2(p.usd), renders: p.renders })),
      runs: v.sessions.slice(0, a.runs ?? 8).map((x) => ({ machine: x.machine, gpu: x.gpu, from: new Date(x.from).toISOString(), to: x.open ? null : new Date(x.to).toISOString(), usdPerHour: x.rate, usd: r2(x.usd), ended: x.open ? "running" : x.why, renders: x.renders.length })),
      advice: v.advice.map((x) => ({ title: x.title, why: x.why, ...(x.save !== null ? { wouldSave: r2(x.save) } : {}) })),
    };
  },
});

const caps = tool({
  name: "caps",
  scope: "look",
  title: "Spending caps",
  description: "The rented GPUs' spending caps (a day, a month; 0: none) with what is spent against them, RunPod's balance, and this token's own cap and spend this month. At a cap the running render ends, then the pods stop, and a deploy or Start is refused. The app's caps are changed with change_setting (rentCaps.day, rentCaps.month: Manage to lower them, Spend too to raise or take them off); this token's own in Afflatus only.",
  async run(_args, ctx) {
    const { s, token } = ctx;
    const settings = await readSettings(s.db);
    const spending = settings.runpodKey || settings.machines.some((m) => m.rented) ? await s.rented.spending().catch(() => null) : null;
    const spent = await s.mcp.tokens.spentThisMonth(token.id);
    ctx.said("Looked at the spending caps");
    return {
      app: { day: settings.rentCaps.day || "none", month: settings.rentCaps.month || "none", ...(spending ? { spentToday: dollars(spending.today), spentThisMonth: dollars(spending.month), balance: spending.balance === null ? null : dollars(spending.balance) } : {}) },
      thisToken: token.scopes.includes("spend") ? { cap: dollars(token.spendCapCents / 100), spentThisMonth: dollars(spent) } : "Spend is not ticked: no rented GPU",
    };
  },
});

export const MACHINE_TOOLS = [listMachines, editMachine, removeMachine, reconnect, pods, deployPod, startPod, stopPod, costsTool, caps];
