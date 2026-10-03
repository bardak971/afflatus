import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Recipe } from "@afflatus/core";
import { now, OWNER } from "./db";
import type { Services } from "./services";

/**
 * Settings that travel with a model file. Each checkpoint has its own sweet spot (sampler, steps, CFG,
 * quality tags…): saved once here, they become the starting values whenever that file is picked,
 * and a draft only records what it changes on top.
 */

const saveBody = z.strictObject({
  family: z.string().min(1),
  file: z.string().min(1).max(500),
  values: z.record(z.string(), z.unknown()),
});
const key = z.object({ family: z.string().min(1), file: z.string().min(1) });

/** The inputs of a family's recipes that may be saved per model. Anything else sent is dropped. */
function perModelInputs(recipes: Recipe<any>[], family: string): Set<string> {
  const ids = new Set<string>();
  for (const r of recipes) if (r.family === family) for (const i of r.inputs) if (i.perModel) ids.add(i.id);
  return ids;
}

export function registerModelSettings(app: FastifyInstance, s: Services): void {
  app.get("/api/model-settings", async () => {
    const rows = await s.db.selectFrom("model_settings").select(["family", "file", "values"]).execute();
    return { items: rows.map((r) => ({ family: r.family, file: r.file, values: JSON.parse(r.values) as Record<string, unknown> })) };
  });

  app.put("/api/model-settings", async (req) => {
    const body = saveBody.parse(req.body);
    if (!s.registry.family(body.family)) throw Object.assign(new Error(`there is no model family called ${body.family}`), { statusCode: 400 });
    const allowed = perModelInputs(s.registry.recipes(), body.family);
    const values = Object.fromEntries(Object.entries(body.values).filter(([id]) => allowed.has(id)));
    const json = JSON.stringify(values);
    const at = now();
    await s.db
      .insertInto("model_settings")
      .values({ owner_id: OWNER, family: body.family, file: body.file, values: json, updated_at: at })
      .onConflict((oc) => oc.columns(["owner_id", "family", "file"]).doUpdateSet({ values: json, updated_at: at }))
      .execute();
    return { family: body.family, file: body.file, values };
  });

  /** Back to the recipe's own defaults for this file. */
  app.delete("/api/model-settings", async (req) => {
    const q = key.parse(req.query);
    await s.db.deleteFrom("model_settings").where("owner_id", "=", OWNER).where("family", "=", q.family).where("file", "=", q.file).execute();
    return { ok: true };
  });
}
