import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { describeRecipe, parseInput } from "@afflatus/core";
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

  /** What is heavy for the card ComfyUI runs on, for one form: a word next to the choice that makes it so. */
  app.post("/api/advice", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()) }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    const scan = await (await s.comfy()).scan().catch(() => null);
    if (!recipe?.advice || !scan?.comfy.online || !scan.comfy.vramTotal) return { items: [] };
    try {
      // a form that is half filled in gets no advice rather than an error
      return { items: recipe.advice(parseInput(recipe, b.input), { vramGb: scan.comfy.vramTotal / 2 ** 30 }) };
    } catch {
      return { items: [] };
    }
  });
}
