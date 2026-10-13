import { REMOVE_BACKGROUND } from "@afflatus/core";
import type { EventEmitter } from "node:events";
import { now, type Db } from "./db";
import { oneAtATime } from "./keyedLock";
import type { Services } from "./services";

/**
 * A Prompt-kit person's pictures without their background, made once each and sent to models in place of the pictures
 * (entities.ts compose): only who they are, never the room they were taken in. MiniMax H3 was seen re-animating a mirror
 * selfie whole, its phone and gilded room, the prompt's café ignored (2026-10-13). BiRefNet, ComfyUI's own remover,
 * cut the owner's four photos cleanly (hair, headphones and hands kept; chairs, mirrors and a train gone).
 *
 * A cut-out is a job like any other (the Remove background tool, labelled "Cut-out · <name>"), so it waits its turn and
 * runs on a machine that can; its result is laid on grey and filed with the person (queueStore.ts), never in the library.
 */

/**
 * What this needs of a person as kept (entities.ts writes it, its schema there; read here alone to keep the two modules
 * apart): their pictures, the switch (on unless set off) and the cut-outs made.
 */
function personOf(def: string): { pictures: string[]; cutout: boolean; cutouts: Record<string, string> } {
  const d = JSON.parse(def) as { pictures?: unknown; cutout?: unknown; cutouts?: unknown };
  const pictures = Array.isArray(d.pictures) ? d.pictures.filter((x): x is string => typeof x === "string") : [];
  const cutouts = d.cutouts && typeof d.cutouts === "object" ? Object.fromEntries(Object.entries(d.cutouts).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  return { pictures, cutout: d.cutout === true, cutouts };
}

/** The person and the picture a cut-out job is for, from its row; null for every other job. */
export function kitForOf(text: string | null | undefined): { person: string; picture: string } | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { person?: unknown; picture?: unknown };
    return typeof v.person === "string" && typeof v.picture === "string" ? { person: v.person, picture: v.picture } : null;
  } catch {
    return null;
  }
}

/**
 * A finished cut-out given to its person: theirs for that picture from now on (one made before for it goes to the bin).
 * A person deleted meanwhile, or who took the picture off, does not want it: it goes to the bin at once.
 */
export async function attachCutout(core: { db: Db; events: EventEmitter }, kit: { person: string; picture: string }, asset: string): Promise<void> {
  const { db } = core;
  await oneAtATime(db, "kit", async () => {
    const row = await db.selectFrom("entities").selectAll().where("id", "=", kit.person).where("kind", "=", "person").executeTakeFirst();
    const p = row ? personOf(row.def) : null;
    const bin = (ids: string[]) => (ids.length ? db.updateTable("assets").set({ deleted_at: now() }).where("id", "in", ids).where("origin", "=", "kit").execute() : null);
    if (!row || !p || !p.pictures.includes(kit.picture)) {
      await bin([asset]);
      return;
    }
    const before = p.cutouts[kit.picture];
    const def = { ...(JSON.parse(row.def) as Record<string, unknown>), cutouts: { ...p.cutouts, [kit.picture]: asset } };
    await db.updateTable("entities").set({ def: JSON.stringify(def), updated_at: now() }).where("id", "=", row.id).execute();
    await db.updateTable("assets").set({ name: `${row.name} · cut-out` }).where("id", "=", asset).execute();
    if (before && before !== asset) await bin([before]);
  });
  core.events.emit("entities");
}

/** A day: a cut-out that failed (no model, a damaged picture) is not asked for again before, on every render. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The cut-outs these people want and do not have yet, queued: for each person whose switch is on, each picture without
 * one, unless one is on its way or failed lately. Nothing is queued when no machine can remove a background (its model
 * not there): the pictures are then sent as they are. Answers how many were queued.
 */
export async function askCutouts(s: Pick<Services, "db" | "queue" | "machines">, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await s.db.selectFrom("entities").select(["id", "name", "def"]).where("id", "in", ids).where("kind", "=", "person").execute();
  const wanted = rows.flatMap((r) => {
    const p = personOf(r.def);
    return p.cutout ? p.pictures.filter((picture) => !p.cutouts[picture]).map((picture) => ({ person: r.id, name: r.name, picture })) : [];
  });
  if (!wanted.length) return 0;
  const since = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const jobs = await s.db.selectFrom("jobs").select(["kit_for", "status", "created_at"]).where("recipe_id", "=", REMOVE_BACKGROUND).where("kit_for", "is not", null).execute();
  const asked = new Set(jobs.filter((j) => j.status === "queued" || j.status === "running" || (j.status === "failed" && j.created_at > since)).map((j) => j.kit_for));
  const todo = wanted.filter((w) => !asked.has(JSON.stringify({ person: w.person, picture: w.picture })));
  if (!todo.length) return 0;
  const model = await removerModel(s);
  if (!model) return 0;
  for (const w of todo) {
    await s.queue.enqueue(REMOVE_BACKGROUND, { source: w.picture, model }, { label: `Cut-out · ${w.name}`, kitFor: { person: w.person, picture: w.picture } });
  }
  return todo.length;
}

/**
 * At start: the cut-outs every person wants and has not (people kept before there were cut-outs, a picture added while
 * ComfyUI was away), asked for in the background, so that the first render with them does not go out with the pictures
 * as they are while their cut-outs are made behind it (seen 2026-10-13). Answers how many were queued.
 */
export async function askEveryCutout(s: Pick<Services, "db" | "queue" | "machines">): Promise<number> {
  const people = await s.db.selectFrom("entities").select("id").where("kind", "=", "person").execute();
  return askCutouts(s, people.map((p) => p.id));
}

/** The background removal model a machine that can run the tool has (the tool's own preference: lucida, birefnet, rmbg), or null when none can. */
async function removerModel(s: Pick<Services, "machines">): Promise<string | null> {
  const scans = await Promise.all((await s.machines()).map(({ comfy }) => comfy.scan(false).catch(() => null)));
  const files = scans.flatMap((scan) => {
    const status = scan?.recipes.find((r) => r.id === REMOVE_BACKGROUND);
    return status?.ready ? (status.options.model ?? []) : [];
  });
  for (const want of ["lucida", "birefnet", "rmbg"]) {
    const hit = files.find((f) => f.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return files[0] ?? null;
}
