import { z } from "zod";
import type { MachineComfy } from "./comfy";
import { now, type Db } from "./db";
import type { Storage } from "./storage";
import { makeStill } from "./thumbs";
import { olderThan } from "./version";

/**
 * Which of a Prompt kit person's pictures a model is sent first: the clearest face, not the first picture (card #220). A
 * model that takes one picture of a person (Krea 2's person reference, H3's first reference, Klein's) followed whichever
 * came first in the kit; a purple-lit selfie first cost 0.06 to 0.09 of likeness against the person's best picture (the
 * #219 pod test). Nothing of a picture is cut or changed: only the order they are sent in.
 *
 * The faces are read by the Afflatus node pack (0.47.0, POST /afflatus/face-facts: InsightFace on the CPU of the machine's
 * ComfyUI, never in its queue), once per picture, kept in face_facts by the picture's id. A pass in the background asks
 * for the pictures not read yet, a few at a time, on a machine that renders nothing then (its ComfyUI's queue empty, no
 * job of Afflatus's on it), never a pod that is not up; it stops at the next picture once that machine is at work. With no
 * machine that has the route, the pictures keep their order in the kit.
 *
 * The ranking is worked out here, from what was read, every time it is asked (the pictures of a person change, the facts
 * do not): a picture with no face found last, those not read yet after those read, and among those read the best face
 * first: large enough, facing the camera, sharp, and most like the person's other pictures.
 */

/** The node pack that answers the route. */
export const FACE_FACTS_PACK = "0.47.0";
/** The version of the pack's answer kept: a picture read by another one is read again. */
const FACTS_VERSION = 1;
/** The picture is sent at this many pixels a side at most: a model sees about that much of it, and every face is read alike. */
const SIDE = 1536;
/** Pictures read in one pass: then the pass ends, and the next one looks again whether the machine is free. */
const PER_PASS = 4;
/** After a pass that read some, the next one, while pictures are left. */
const AGAIN_MS = 15_000;
/** Every so often, the pictures not read yet looked for (a machine came up, a render ended). */
const EVERY_MS = 10 * 60_000;
/** A machine without the route (an older pack, no insightface) is not asked again before this long. */
const ABSENT_MS = 30 * 60_000;

const facts = z.object({
  version: z.number().int(),
  width: z.number().positive(),
  height: z.number().positive(),
  faces: z.number().int().min(0),
  face: z.object({
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    points: z.array(z.tuple([z.number(), z.number()])).length(5).nullable(),
    score: z.number(),
    sharp: z.number().min(0),
    embedding: z.array(z.number()).min(16).max(2048),
  }).nullable(),
});
export type FaceFacts = z.infer<typeof facts>;

// ---------------------------------------------------------------- the ranking

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * How much a face looks at the camera, 0 to 1, from its five points (the eyes, the nose, the mouth's corners): the nose
 * midway between the eyes and the mouth's corners (a head turned moves it to one side, about half the eyes' distance at a
 * profile) and at its usual height between them (a head tipped up or down moves it there). A tilted head is taken level
 * first: a tilt is no worse a reference. Without points, half.
 */
export function frontalOf(points: ReadonlyArray<readonly [number, number]> | null): number {
  if (!points) return 0.5;
  const [le, re] = points;
  const angle = Math.atan2(re![1] - le![1], re![0] - le![0]);
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const [l, r, nose, ml, mr] = points.map(([x, y]) => [x * c - y * s, x * s + y * c] as const);
  const eyes = Math.hypot(r![0] - l![0], r![1] - l![1]);
  if (eyes <= 0) return 0;
  const middle = (l![0] + r![0] + ml![0] + mr![0]) / 4;
  const turned = Math.abs(nose![0] - middle) / eyes;
  const eyeLine = (l![1] + r![1]) / 2;
  const span = (ml![1] + mr![1]) / 2 - eyeLine;
  const height = span > 0 ? (nose![1] - eyeLine) / span : 0;
  return clamp01(1 - turned / 0.5) * clamp01(1 - Math.max(0, Math.abs(height - 0.55) - 0.15) / 0.3);
}

/** A face this high (in the picture as read, SIDE a side at most) is large enough: a smaller one counts for less, in proportion. */
const FULL_HEIGHT = 256;
/** A face this sharp (the Laplacian's variance at 112 px a side) is sharp enough. */
const FULL_SHARP = 150;
/** A face this frontal is frontal enough: a head turned a little is no worse a reference. */
const FULL_FRONTAL = 0.8;

/**
 * How good a reference a picture's face is, 0 to 1, leaving out whose it is: large enough, facing the camera, sharp, and
 * sure to be a face. Each counts up to "enough", so that among good pictures their likeness to each other decides. 0
 * without a face.
 */
export function qualityOf(f: FaceFacts): number {
  if (!f.face) return 0;
  const size = clamp01((f.face.box[3] - f.face.box[1]) / FULL_HEIGHT);
  const frontal = clamp01(frontalOf(f.face.points) / FULL_FRONTAL);
  const sharp = Math.sqrt(clamp01(f.face.sharp / FULL_SHARP));
  const sure = clamp01(f.face.score / 0.8);
  return size * frontal * sharp * sure;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!;
  return dot;
};

/**
 * A person's pictures in the order they are sent: those read with a face first, the best first (qualityOf × how much the
 * face is the one of their other pictures, ArcFace, each other picture counted by its own quality: a far, blurred shot says
 * less of who they are); then those not read yet, in the kit's order; then those where no face was found. Pictures of the
 * same worth keep the kit's order. The same pictures and facts give the same order.
 */
export function bestFirst(pictures: readonly string[], known: ReadonlyMap<string, FaceFacts>): string[] {
  const faced = pictures.filter((p) => known.get(p)?.face);
  const quality = new Map(faced.map((p) => [p, qualityOf(known.get(p)!)]));
  const likeness = (p: string) => {
    const others = faced.filter((o) => o !== p);
    if (!others.length) return 1;
    const own = known.get(p)!.face!.embedding;
    const weights = others.map((o) => quality.get(o)!);
    const total = weights.reduce((a, b) => a + b, 0);
    const sims = others.map((o) => cosine(own, known.get(o)!.face!.embedding));
    return clamp01(total > 0 ? sims.reduce((a, s, i) => a + s * weights[i]!, 0) / total : sims.reduce((a, b) => a + b, 0) / sims.length);
  };
  const worth = new Map(faced.map((p) => [p, quality.get(p)! * likeness(p)]));
  const place = (p: string) => (worth.has(p) ? 0 : known.has(p) ? 2 : 1);
  return pictures
    .map((p, i) => ({ p, i }))
    .sort((a, b) => place(a.p) - place(b.p) || (worth.get(b.p) ?? 0) - (worth.get(a.p) ?? 0) || a.i - b.i)
    .map((x) => x.p);
}

/** What the form and the kit say of a person's pictures: in the order they are sent, and those found faceless or not read yet. */
export interface PictureFaces {
  /** The pictures, the one sent first first. */
  order: string[];
  /** Pictures where no face was found: sent last. */
  none: string[];
  /** Pictures not read yet (no machine with the node pack's route free since they were added): their kit order stands. */
  unread: string[];
}

/** The facts kept of these pictures, read by the current version of the route. */
export async function factsOf(db: Db, pictures: readonly string[]): Promise<Map<string, FaceFacts>> {
  const ids = [...new Set(pictures)];
  if (!ids.length) return new Map();
  const rows = await db.selectFrom("face_facts").select(["asset_id", "facts"]).where("asset_id", "in", ids).where("version", "=", FACTS_VERSION).execute();
  const out = new Map<string, FaceFacts>();
  for (const r of rows) {
    const got = facts.safeParse(JSON.parse(r.facts));
    if (got.success) out.set(r.asset_id, got.data);
  }
  return out;
}

/** A person's pictures as they are sent, and what is known of their faces. `known` from factsOf (one read for many people). */
export const facesOf = (pictures: readonly string[], known: ReadonlyMap<string, FaceFacts>): PictureFaces => ({
  order: bestFirst(pictures, known),
  none: pictures.filter((p) => known.has(p) && !known.get(p)!.face),
  unread: pictures.filter((p) => !known.has(p)),
});

/** A person's pictures in the order they are sent: `picked` first when it is one of them (the form's own pick wins), else the best face first. */
export const sentOrder = (order: readonly string[], picked: string | null | undefined): string[] =>
  picked && order.includes(picked) ? [picked, ...order.filter((p) => p !== picked)] : [...order];

// ---------------------------------------------------------------- reading them in the background

interface Deps {
  db: Db;
  storage: Storage;
  machines(): Promise<MachineComfy[]>;
  /** Whether Afflatus has work on a machine, or its ComfyUI work from outside (the queue's busyOn). */
  busyOn(machine: string): boolean;
  /** Why a rented machine's pod is not up (rented.ts podDown); null: up, or not a rented one. */
  podDown(machine: string): string | null;
  /** Told when pictures were read: the kit's pages read their order again. */
  read(): void;
}

/** The pictures of the kit's people that are not read yet (or were read by an older route), the kit's order. */
async function unread(db: Db): Promise<Array<{ id: string; file_key: string }>> {
  const people = await db.selectFrom("entities").select("def").where("kind", "=", "person").orderBy("created_at").execute();
  const wanted = [...new Set(people.flatMap((p) => ((JSON.parse(p.def) as { pictures?: unknown }).pictures as string[] | undefined) ?? []))].filter((x) => typeof x === "string");
  if (!wanted.length) return [];
  const done = new Set((await db.selectFrom("face_facts").select("asset_id").where("asset_id", "in", wanted).where("version", "=", FACTS_VERSION).execute()).map((r) => r.asset_id));
  const left = wanted.filter((id) => !done.has(id));
  if (!left.length) return [];
  const rows = await db.selectFrom("assets").select(["id", "file_key"]).where("id", "in", left).where("kind", "=", "image").where("deleted_at", "is", null).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return left.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export class FaceReader {
  private running: Promise<number> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private every: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Machines without the route, until when they are not asked again (by machine id and the address asked). */
  private absent = new Map<string, number>();

  constructor(private readonly d: Deps, private readonly clock: () => number = Date.now) {}

  /** Read what is not read yet, every so often and `firstMs` after this. */
  start(firstMs = 60_000): void {
    this.soon(firstMs);
    this.every = setInterval(() => this.soon(0), EVERY_MS);
    this.every.unref?.();
  }

  /** A pass in a moment: after a change of the kit (several changes make one pass). */
  soon(ms = 3_000): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().then((n) => n > 0 && this.soon(AGAIN_MS), () => {});
    }, ms);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.every) clearInterval(this.every);
  }

  /** One pass, one at a time: how many pictures it read. */
  run(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.pass().catch((err: Error) => {
      console.warn("[face facts]", err.message);
      return 0;
    }).finally(() => (this.running = null));
    return this.running;
  }

  /** A machine free for it: up, nothing of Afflatus's nor anyone's in its ComfyUI. */
  private async free(m: MachineComfy): Promise<boolean> {
    if (this.d.podDown(m.machine.id) !== null || this.d.busyOn(m.machine.id)) return false;
    const q = await m.comfy.client.queue().catch(() => null);
    return Boolean(q && !q.running.length && !q.pending.length);
  }

  /** The first machine with the route that renders nothing now. */
  private async machine(): Promise<MachineComfy | null> {
    for (const m of await this.d.machines()) {
      const key = `${m.machine.id} ${m.machine.url}`;
      if ((this.absent.get(key) ?? 0) > this.clock()) continue;
      if (this.d.podDown(m.machine.id) !== null) continue;
      const pack = await m.comfy.client.packVersion().catch(() => null);
      if (!pack || olderThan(pack, FACE_FACTS_PACK)) {
        if (pack) this.absent.set(key, this.clock() + ABSENT_MS);
        continue;
      }
      if (await this.free(m)) return m;
    }
    return null;
  }

  private async pass(): Promise<number> {
    // the facts of pictures no longer in the library (the bin emptied) go with them
    await this.d.db.deleteFrom("face_facts").where("asset_id", "not in", this.d.db.selectFrom("assets").select("id")).execute();
    const todo = (await unread(this.d.db)).slice(0, PER_PASS);
    if (!todo.length) return 0;
    const m = await this.machine();
    if (!m) return 0;
    let read = 0;
    for (const pic of todo) {
      // a render started on it meanwhile: the rest waits for the next pass
      if (this.stopped || (read > 0 && !(await this.free(m)))) break;
      const bytes = await this.d.storage.get(pic.file_key).catch(() => null);
      if (!bytes) continue;
      const still = await makeStill(bytes, SIDE);
      const got = still ? await m.comfy.client.faceFacts(still) : "unreadable";
      if (got === "absent") {
        this.absent.set(`${m.machine.id} ${m.machine.url}`, this.clock() + ABSENT_MS);
        break;
      }
      if (got === null) break;
      // a picture that cannot be read as one has no face to send first: last, as one without a face
      const said = got === "unreadable" ? { version: FACTS_VERSION, width: 1, height: 1, faces: 0, face: null } : facts.safeParse(got).data;
      if (!said || said.version !== FACTS_VERSION) break;
      await this.d.db.insertInto("face_facts").values({ asset_id: pic.id, version: FACTS_VERSION, facts: JSON.stringify(said), read_at: now() })
        .onConflict((oc) => oc.column("asset_id").doUpdateSet({ version: FACTS_VERSION, facts: JSON.stringify(said), read_at: now() })).execute();
      read++;
    }
    if (read) this.d.read();
    return read;
  }
}
