import { newId, type Db } from "../apps/server/src/db";

/**
 * A past for the queue's history in the demo: a few failed and cancelled jobs beside the done ones the
 * pretend renders left, and one batch asked for together. Made once, from the done jobs there are.
 */
export async function seedHistory(db: Db): Promise<void> {
  const have = await db.selectFrom("jobs").select("id").where("status", "=", "failed").limit(1).executeTakeFirst();
  if (have) return;
  const done = await db.selectFrom("jobs").selectAll().where("status", "=", "done").where("warm", "=", 0).orderBy("finished_at", "desc").limit(8).execute();
  if (!done.length) return;
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const errors = [
    "CUDA out of memory. Tried to allocate 2.40 GiB (GPU 0; 11.99 GiB total capacity; 9.80 GiB already allocated)",
    "ComfyUI: the model file was not found: demo-pony.safetensors",
    "ComfyUI went away during the render",
  ];
  const rows = [
    ...done.slice(0, 3).map((d, i) => ({ ...d, id: newId(), status: "failed" as const, error: errors[i]!, generation_id: null, resume: null, created_at: at(40 + i * 7), started_at: at(39 + i * 7), finished_at: at(38 + i * 7), updated_at: at(38 + i * 7) })),
    ...done.slice(0, 5).map((d, i) => ({ ...d, id: newId(), status: "cancelled" as const, error: "stopped by you", generation_id: null, resume: null, created_at: at(90 + i * 3), started_at: null, finished_at: at(89 + i * 3), updated_at: at(89 + i * 3) })),
  ];
  await db.insertInto("jobs").values(rows).execute();
  // four pictures asked for together: the same form, the same second
  const four = done.filter((d) => d.recipe_id.startsWith("sdxl")).slice(0, 4);
  if (four.length >= 2) {
    await db.updateTable("jobs").set({ created_at: at(20), label: four[0]!.label, draft_id: four[0]!.draft_id }).where("id", "in", four.map((f) => f.id)).execute();
  }
}
