import { httpError } from "./errors";
import type { FastifyInstance } from "fastify";
import { said } from "./forecast";
import { z } from "zod";
import { describeRecipe } from "@afflatus/core";
import { installNodePack } from "./nodePack";
import { preflight } from "./preflight";
import type { Services } from "./services";
import { publicSettings, readSettings, writeSettings } from "./settings";

/** Afflatus itself and its ComfyUI: whether it is alive, what it can make, the settings, the setup scan, the log, and advice on a form. */

export function registerSetup(app: FastifyInstance, s: Services, version: string): void {
  /** Alive, the version, the database, and the start-up checks (the tools, the Node, the data folder) as they were last run. */
  const health = (checks: typeof preflight.last) => ({ ok: true, version, database: s.dbKind, checks: checks?.checks ?? [], checkedAt: checks?.at ?? null });
  app.get("/api/health", async () => health(preflight.last));
  /** The start-up checks run again, now (Settings → About → Check again). */
  app.post("/api/health/check", async () => health(await preflight.run()));

  /** Everything the composer can make things with, and the form of each. */
  app.get("/api/recipes", async () => ({ families: s.registry.families(), recipes: s.registry.recipes().map(describeRecipe) }));

  app.get("/api/settings", async () => publicSettings(await readSettings(s.db)));
  app.put("/api/settings", async (req) => {
    const saved = await writeSettings(s.db, req.body);
    // a file chosen by hand for a family: what is ready is worked out again
    if (req.body && typeof req.body === "object" && "slotFiles" in req.body) (await s.comfy()).forgetScan();
    // ComfyUI's folder set: Afflatus's node pack goes into its custom_nodes (ComfyUI loads it at its next start)
    if (req.body && typeof req.body === "object" && "comfyDir" in req.body && saved.comfyDir.trim()) {
      await installNodePack(saved.comfyDir).catch((err: Error) => console.warn(`[node-pack] not written: ${err.message}`));
    }
    return publicSettings(saved);
  });

  /** What ComfyUI can do: the setup page, and what the composer offers. Read-only on ComfyUI. */
  app.get("/api/setup", async () => (await s.comfy()).scan());
  /** The same, asked of ComfyUI afresh rather than from what was learned a moment ago ("Test" in Settings). */
  app.post("/api/setup/rescan", async () => (await s.comfy()).scan(true));

  /** ComfyUI's terminal log, the last few hundred lines: the Queue page's log tab reads it every couple of seconds. */
  app.get("/api/comfy/logs", async () => ({ lines: await (await s.comfy()).client.logs() }));

  /**
   * Restart ComfyUI, through ComfyUI-Manager's reboot (it starts itself again with the same command
   * line): after node packs were installed, which ComfyUI only loads at start. Refused while a render
   * runs. What was learned of ComfyUI is forgotten: the new node types show at the next read.
   */
  app.post("/api/comfy/restart", async () => {
    if ((await s.queue.status()).running) throw httpError("A render is running: restart ComfyUI once it is done.", 409);
    const comfy = await s.comfy();
    let res: Response | null = null;
    try {
      res = await fetch(comfy.client.baseUrl + "/v2/manager/reboot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    } catch {
      // the process replaces itself as it answers: a dropped connection is the restart under way
    }
    if (res?.status === 404) throw httpError("This ComfyUI has no ComfyUI-Manager, which does the restarting: restart ComfyUI by hand.");
    if (res?.status === 403) throw httpError("ComfyUI-Manager does not allow a restart from outside at its security level: restart ComfyUI by hand.");
    if (res && !res.ok) throw httpError(`ComfyUI-Manager refused the restart (${res.status}): restart ComfyUI by hand.`);
    comfy.forgetAll();
    return { ok: true };
  });

  /**
   * What a form will take, learned from this machine's own renders with the same model (see forecast.ts): a
   * line for the form's Output part, and whether it is past where the card slowed down before (the part's
   * header says so then). Nothing is assumed about the card; a model never rendered here says nothing.
   */
  app.post("/api/advice", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()) }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    const got = recipe ? await s.queue.forecast(b.recipe, b.input).catch(() => null) : null;
    if (!recipe || !got) return { estimate: null };
    return { estimate: { text: said(got.forecast, got.shape).text, pace: got.forecast.pace } };
  });
}
