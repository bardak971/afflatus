import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deployFiles, deployModels } from "./deployModels";
import { setsWithFiles } from "./modelSets";
import { keptHoldings, missingOn } from "./rentedVolumes";
import { fillPlan, volumePlan } from "./volumePlan";
import { deleteVolumeFiles, volumeFiles } from "./volumeFiles";
import { httpError } from "./errors";
import { podMachineId, podUrl } from "./runpod";
import type { Services } from "./services";
import { deploySchema, readSettings, updateSettings } from "./settings";

/**
 * Rented machines (rented.ts): the user's pods on RunPod listed for adding one, a pod added as a machine, a GPU deployed,
 * Start and Stop (or Terminate) by the user, and what they cost. Nothing here starts or deploys a pod unless the user asked:
 * Start and Deploy are routes of their own, each a click.
 */

export function registerRented(app: FastifyInstance, s: Services): void {
  const params = z.object({ id: z.string().max(40) });

  /** The user's pods, read with the key: which expose ComfyUI's port, which are added already. Read-only. */
  app.get("/api/runpod/pods", async () => ({ pods: await s.rented.pods() }));

  /**
   * A run's boot log as kept (Settings › Rented GPUs › boot logs, rentedFollow keepBootLog), as plain text: RunPod's system
   * log of its pull, then the pod's own boot log. 404 when none is kept for it (not kept then, or dropped since).
   */
  app.get("/api/rented/sessions/:id/boot-log", async (req, reply) => {
    const { id } = params.parse(req.params);
    const row = await s.db.selectFrom("rent_sessions").select(["boot_log", "gpu", "started_at"]).where("id", "=", id).executeTakeFirst();
    if (!row?.boot_log) throw httpError("No boot log is kept for that run.", 404);
    const log = JSON.parse(row.boot_log) as { system?: Array<{ ts: string; line: string }>; pod?: Array<{ t: string; m: string }> };
    const text = [
      `${row.gpu ?? "Pod"}, deployed ${row.started_at}`,
      "",
      "RunPod's system log (the image's pull):",
      ...(log.system ?? []).map((l) => `${l.ts}  ${l.line}`),
      "",
      "The pod's boot log:",
      ...(log.pod ?? []).map((l) => `${l.t}  ${l.m}`),
      "",
    ].join("\n");
    return reply.type("text/plain; charset=utf-8").header("Content-Disposition", `inline; filename="boot-log-${id.slice(0, 8)}.txt"`).send(text);
  });

  /** The GPUs a pod can be deployed on now, on that cloud, with their price and where they are free; read-only. */
  app.get("/api/runpod/gpus", async (req) => {
    const { cloud } = z.object({ cloud: z.enum(["SECURE", "COMMUNITY"]).default("SECURE") }).parse(req.query);
    return { gpus: await s.rented.gpus(cloud) };
  });

  /** The account's network volumes, each with the pod running on it when one is; read-only. */
  app.get("/api/runpod/volumes", async () => {
    const [volumes, sets, kept] = await Promise.all([s.rented.volumes(), setsWithFiles(s), keptHoldings(s.db)]);
    // each set as the volume held it last time a pod ran there: all there, or what it lacks
    return { volumes: volumes.map((v) => {
      const keys = kept.get(v.id)?.keys ?? null;
      return { ...v, sets: keys ? sets.filter((x) => x.files.length).map((x) => ({ id: x.id, name: x.name, missing: missingOn(x.files, keys) })) : [] };
    }) };
  });

  /** A network volume made (Make a volume…, its monthly price said on the button): billed every month from now. */
  app.post("/api/runpod/volumes", async (req) => {
    const { name, size, dataCenter } = z.strictObject({ name: z.string().trim().min(1).max(60), size: z.number().int(), dataCenter: z.string().min(1).max(40) }).parse(req.body);
    return { volume: await s.rented.makeVolume(name, size, dataCenter) };
  });

  /** What Make a volume… says first: where (GPUs in stock there now), what size the sets want, whether it pays for itself. Read-only. */
  app.get("/api/runpod/volumes/plan", async (req) => {
    const { sets } = z.object({ sets: z.string().max(2000).optional() }).parse(req.query);
    return volumePlan(s, sets ? sets.split(",").filter(Boolean).slice(0, 20) : null);
  });

  /** What Fill from a set… says first: the GPU it takes and its price, what the volume lacks of the set, how long, what it costs. */
  app.get("/api/runpod/volumes/:id/fill", async (req) => {
    const { set } = z.object({ set: z.string().min(1).max(80) }).parse(req.query);
    return fillPlan(s, z.object({ id: z.string().max(80) }).parse(req.params).id, set);
  });

  /**
   * Fill from a set…: the cheapest GPU in stock where the volume is, deployed only to fetch the set's files onto it, then
   * terminated. Billed from now, on the user's click; each preset's licence accepted first, as for a deploy.
   */
  app.post("/api/runpod/volumes/:id/fill", async (req) => {
    const { set, accept } = z.strictObject({ set: z.string().min(1).max(80), accept: z.array(z.string().max(120)).max(40).default([]) }).parse(req.body);
    const files = await deployFiles(s, { set, files: [], accept, again: true });
    if (!files.length) throw httpError("That set brings no file.");
    return s.rented.fill(z.object({ id: z.string().max(80) }).parse(req.params).id, set, files);
  });

  /** What a volume holds (its Files): read through RunPod's S3 API when it can, else as its last pod listed it. Read-only. */
  app.get("/api/runpod/volumes/:id/files", async (req) => volumeFiles(s, z.object({ id: z.string().max(80) }).parse(req.params).id));

  /** Files of a volume's models folder deleted for good, through S3: refused for a file a render on its pod needs now. */
  app.post("/api/runpod/volumes/:id/files/delete", async (req) => {
    const { keys } = z.strictObject({ keys: z.array(z.string().min(1).max(1024)).min(1).max(500) }).parse(req.body);
    return deleteVolumeFiles(s, z.object({ id: z.string().max(80) }).parse(req.params).id, keys);
  });

  /** A network volume made larger (Grow…). */
  app.patch("/api/runpod/volumes/:id", async (req) => {
    const { size } = z.strictObject({ size: z.number().int() }).parse(req.body);
    await s.rented.growVolume(z.object({ id: z.string().max(80) }).parse(req.params).id, size);
    return { ok: true };
  });

  /** A network volume deleted with what it holds (Delete…): refused while a pod is mounted on it. */
  app.delete("/api/runpod/volumes/:id", async (req) => {
    await s.rented.deleteVolume(z.object({ id: z.string().max(80) }).parse(req.params).id);
    return { ok: true };
  });

  /** Whether each image a deploy may run can be pulled now: the dialog says which cannot. */
  app.get("/api/runpod/images", async () => s.rented.images());

  /** A machine removed from Afflatus (its card's Remove): a rented pod is left on RunPod as it is, its secret until it goes. */
  app.post("/api/machines/:id/remove", async (req) => {
    await s.rented.remove(params.parse(req.params).id);
    return { ok: true };
  });

  /** What the Deploy dialog's Models part shows: the waiting jobs' files, the picked set's, and what earlier deploys measured. Read-only. */
  app.get("/api/runpod/deploy/models", async (req) => {
    const q = z.object({ cloud: z.enum(["SECURE", "COMMUNITY"]).default("SECURE"), set: z.string().max(80).default("") }).parse(req.query);
    return deployModels(s, q);
  });

  /** A GPU deployed, as the dialog asked: billed from now. The user's click only; refused at a spending cap. */
  app.post("/api/runpod/deploy", async (req) => {
    const ask = deploySchema.parse(req.body);
    // the GPU hunt's own deploy between its pick and RunPod's answer: this one would be a second pod for the same renders
    if (s.hunt.view().hunt?.status === "deploying") throw httpError("The GPU hunt is deploying a GPU now: wait for it to end.", 409);
    return s.rented.deploy(async () => ({ ...ask, files: await deployFiles(s, ask), again: false }));
  });

  /** A pod added as a machine, as it is (running or stopped): its ComfyUI's address worked out from it. Nothing is started. */
  app.post("/api/runpod/add", async (req) => {
    const { pod } = z.object({ pod: z.string().min(1).max(80) }).parse(req.body);
    const found = (await s.rented.pods()).find((p) => p.id === pod);
    if (!found) throw httpError("RunPod has no such pod on this account.", 404);
    if (!found.comfy) throw httpError("This pod does not expose ComfyUI's port (8188, HTTP): add it on RunPod, then add the pod here.", 409);
    if (found.added) throw httpError("This pod is added already.", 409);
    let id = "";
    await updateSettings(s.db, (current) => {
      // its id is the pod's: never one a machine had before (whose pause and learned speed it would take on), and the same
      // when the pod is removed and added again, so that it keeps its own history
      id = podMachineId(found.id);
      if (current.machines.some((m) => m.id === id)) throw httpError("This pod is added already.", 409);
      // idle: without a volume, a stop keeps nothing (its container disk is erased) and its GPU may be taken meanwhile, so that
      // it cannot start again: terminated then; with one, stopped (its disk kept, billed)
      const volume = found.networkVolume || found.diskGb > 0;
      const rented = { provider: "runpod" as const, pod: found.id, idleMinutes: 10, idleDo: volume ? ("stop" as const) : ("terminate" as const), watchdogMinutes: 15, openPorts: false, closedPorts: [], secret: "", deployed: false, deployedAt: "" };
      // added again: its secret is its own once more, not one to delete when it goes
      return { machines: [...current.machines, { id, name: found.name.slice(0, 40), url: podUrl(found.id), dir: "", takes: "all", packs: "ask", families: {}, rented }], leftSecrets: current.leftSecrets.filter((l) => l.pod !== found.id) };
    });
    s.queue.events.emit("setup");
    await s.rented.poll().catch(() => {});
    return { id };
  });

  /** The user's Start: refused at a spending cap. Afflatus never starts a pod otherwise. */
  app.post("/api/machines/:id/start", async (req) => s.rented.start(params.parse(req.params).id));

  /** The user's Stop (the disk goes on billing) or Terminate (nothing billed, the pod gone, and gone from Afflatus too). */
  app.post("/api/machines/:id/stop", async (req) => {
    const { how } = z.object({ how: z.enum(["stop", "terminate"]).default("stop") }).parse(req.body ?? {});
    return s.rented.stopBy(params.parse(req.params).id, how);
  });

  /** What the rented GPUs cost today and this month, the caps, and RunPod's balance; nothing without a rented machine. */
  app.get("/api/rented/spending", async () => {
    const settings = await readSettings(s.db);
    // with a key and no pod, storage still bills (a volume left behind): read whenever there is a key
    if (!settings.runpodKey && !settings.machines.some((m) => m.rented)) return { spending: null };
    return { spending: await s.rented.spending() };
  });
}
