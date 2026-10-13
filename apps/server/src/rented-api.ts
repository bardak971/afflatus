import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { podUrl } from "./runpod";
import type { Services } from "./services";
import { readSettings, updateSettings } from "./settings";

/**
 * Rented machines (rented.ts): the user's pods on RunPod listed for adding one, a pod added as a machine, Start and Stop (or
 * Delete) by the user, and what they cost. Nothing here starts a pod unless the user asked: Start is a route of its own.
 */
/** A pod's machine id: "rp-" and its id, as a machine id may be written (lower-case letters, digits, dashes; 24 at most). */
export const podMachineId = (pod: string) => `rp-${pod.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 21)}`;

export function registerRented(app: FastifyInstance, s: Services): void {
  const params = z.object({ id: z.string().max(40) });

  /** The user's pods, read with the key: which expose ComfyUI's port, which are added already. Read-only. */
  app.get("/api/runpod/pods", async () => ({ pods: await s.rented.pods() }));

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
      const rented = { provider: "runpod" as const, pod: found.id, idleMinutes: 10, idleDo: "stop" as const, watchdogMinutes: 15 };
      return { machines: [...current.machines, { id, name: found.name.slice(0, 40), url: podUrl(found.id), dir: "", takes: "all", families: {}, rented }] };
    });
    s.queue.events.emit("setup");
    await s.rented.poll().catch(() => {});
    return { id };
  });

  /** The user's Start: refused at a spending cap. Afflatus never starts a pod otherwise. */
  app.post("/api/machines/:id/start", async (req) => s.rented.start(params.parse(req.params).id));

  /** The user's Stop (the disk goes on billing) or Delete (terminate: nothing billed, the pod gone). */
  app.post("/api/machines/:id/stop", async (req) => {
    const { how } = z.object({ how: z.enum(["stop", "terminate"]).default("stop") }).parse(req.body ?? {});
    return s.rented.stopBy(params.parse(req.params).id, how);
  });

  /** What the rented GPUs cost today and this month, the caps, and RunPod's balance; nothing without a rented machine. */
  app.get("/api/rented/spending", async () => {
    const settings = await readSettings(s.db);
    if (!settings.machines.some((m) => m.rented)) return { spending: null };
    return { spending: await s.rented.spending() };
  });
}
