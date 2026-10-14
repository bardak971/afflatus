import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deployFiles, deployModels } from "./deployModels";
import { setsWithFiles } from "./modelSets";
import { keptHoldings, missingOn } from "./rentedVolumes";
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
      const keys = kept.get(v.id)?.keys;
      return { ...v, sets: keys ? sets.filter((x) => x.files.length).map((x) => ({ id: x.id, name: x.name, missing: missingOn(x.files, keys) })) : [] };
    }) };
  });

  /** A network volume made (Make a volume…, its monthly price said on the button): billed every month from now. */
  app.post("/api/runpod/volumes", async (req) => {
    const { name, size, dataCenter } = z.strictObject({ name: z.string().trim().min(1).max(60), size: z.number().int(), dataCenter: z.string().min(1).max(40) }).parse(req.body);
    return { volume: await s.rented.makeVolume(name, size, dataCenter) };
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
    return s.rented.deploy({ ...ask, files: await deployFiles(s, ask), again: false });
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
      return { machines: [...current.machines, { id, name: found.name.slice(0, 40), url: podUrl(found.id), dir: "", takes: "all", families: {}, rented }], leftSecrets: current.leftSecrets.filter((l) => l.pod !== found.id) };
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
