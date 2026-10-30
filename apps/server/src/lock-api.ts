import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ComfyClient, LOCKED_HEADER } from "@afflatus/comfy";
import type { Comfy, MachineComfy } from "./comfy";
import { loginKeyOf, loginsFor } from "./comfyLogins";
import { httpError } from "./errors";
import type { Services } from "./services";
import { fromThisComputer } from "./hostCheck";
import { readSettings, updateSettings } from "./settings";
import { olderThan } from "./version";

/**
 * Locking a ComfyUI to Afflatus (Settings › ComfyUI, a machine's Access line). The lock itself is the node pack's
 * (comfy-nodes/afflatus-nodes/lock.py): once set, every route of that ComfyUI's server needs the machine's token, which
 * Afflatus keeps in the settings and sends on every call (ComfyClient). Here: making the token and checking that the lock
 * took, renewing it, taking it off, pasting a token made elsewhere, and opening ComfyUI's own page logged in.
 */

/** The first node pack with the lock. */
export const PACK_LOCK = "0.12.0";
/** ComfyUI-Manager before this let anyone who reached it install a node pack: the way the 2026 botnet got in. */
export const MANAGER_SAFE = "3.38";

/** What GET /afflatus/lock says. */
interface PackLock {
  locked: boolean;
  local: boolean;
  fixed: boolean;
  off: boolean;
}

/** A machine's access, as Settings shows it on its card. */
export interface Access {
  /** open: no lock; locked: locked, and Afflatus's token works; wrong: locked against the token Afflatus has (or has none); unknown: it does not answer. */
  state: "open" | "locked" | "wrong" | "unknown";
  /** Its node pack can lock it (PACK_LOCK or newer). */
  canLock: boolean;
  /** Calls made on ComfyUI's own computer get in without the token. */
  local: boolean;
  /** Locked by its start settings (AFFLATUS_TOKEN): not changed from here. */
  fixed: boolean;
  /** Started with AFFLATUS_LOCK=off: it cannot be locked until it is started without it. */
  off: boolean;
  /** ComfyUI-Manager's version when it has one, and whether it is older than MANAGER_SAFE. */
  manager: string | null;
  managerOld: boolean;
}

/** A machine's token: 32 random bytes, as base64url. */
export const newToken = () => randomBytes(32).toString("base64url");
const plain = (v: string) => v.replace(/^v/i, "").trim();

async function packLock(comfy: Comfy): Promise<PackLock | null> {
  const res = await comfy.client.raw("/afflatus/lock", { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as PackLock | null;
}

/** ComfyUI-Manager's version on this ComfyUI, null without it (or when it does not answer). */
export async function managerOf(comfy: Comfy): Promise<string | null> {
  const res = await comfy.client.raw("/v2/manager/version", { signal: AbortSignal.timeout(5000) }).catch(() => null);
  return res?.ok ? plain((await res.text()).slice(0, 40)) : null;
}

/** Whether a call without the token, as if from another machine, is refused by the lock (and not let in, or refused by something else). */
async function refusedWithout(comfy: Comfy): Promise<boolean> {
  // the stand-in for "another machine": a call through a proxy is never one "from this PC", so the check holds when calls
  // made on ComfyUI's own computer are let in, and Afflatus runs on that computer
  const res = await fetch(`${comfy.client.baseUrl}/system_stats`, { headers: { "X-Forwarded-For": "192.0.2.1" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  await res?.body?.cancel().catch(() => {});
  return res?.status === 401 && Boolean(res.headers.get(LOCKED_HEADER));
}

/** A machine's access, asked now: its lock, its pack, its ComfyUI-Manager. Read-only. */
export async function accessOf(comfy: Comfy, online: boolean, locked: boolean, pack: string | null): Promise<Access> {
  const [lock, manager] = online ? await Promise.all([packLock(comfy), managerOf(comfy)]) : [null, null];
  const state: Access["state"] = locked ? "wrong" : !online ? "unknown" : lock?.locked ? "locked" : "open";
  return {
    state, canLock: Boolean(pack && !olderThan(pack, PACK_LOCK)), local: Boolean(lock?.local), fixed: Boolean(lock?.fixed), off: Boolean(lock?.off),
    manager, managerOld: Boolean(manager && olderThan(manager, MANAGER_SAFE)),
  };
}

/**
 * The address that opens ComfyUI's own page at `path` (its editor, a workflow in it): locked, its login with a one-time
 * code (a minute long) that lands there, so the browser is logged in and the token is never in an address bar or a
 * history; open, the page itself. The login is the one of `key`, the Afflatus sign-in asking (comfyLogins.ts), and ends
 * with it.
 */
export async function pageUrl(s: Pick<Services, "access">, comfy: Comfy, key: string, path = "/"): Promise<string> {
  const plainUrl = `${comfy.client.baseUrl}${path === "/" ? "" : path}`;
  const token = comfy.client.token;
  if (!token) return plainUrl;
  const logins = await loginsFor(s.access, token, key);
  if (!logins) throw httpError("Sign in first: this Afflatus has a password.", 401);
  // the logins still good go with it: a ComfyUI not told lately (lock.py's LEASE_S) is told now
  const res = await comfy.client.raw("/afflatus/login-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(logins), signal: AbortSignal.timeout(5000) }).catch(() => null);
  // not locked after all (opened by hand): the page opens as it is
  if (res?.status === 409) return plainUrl;
  if (!res?.ok) throw httpError("ComfyUI did not give a login code: is it running, and is its token still the one Afflatus has?", 502);
  const { code } = (await res.json()) as { code: string };
  return `${comfy.client.baseUrl}/afflatus/login?code=${encodeURIComponent(code)}${path === "/" ? "" : `&next=${encodeURIComponent(path)}`}`;
}

async function post(comfy: Comfy, path: string, body: unknown): Promise<Response> {
  const res = await comfy.client.raw(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch((err: Error) => {
    throw httpError(`ComfyUI did not answer: ${err.message}`, 502);
  });
  if (res.status === 401 && res.headers.get(LOCKED_HEADER)) throw httpError("This ComfyUI is locked with a token Afflatus does not have: paste its token first.", 409);
  if (!res.ok) throw httpError((await res.text().catch(() => "")).slice(0, 300) || `ComfyUI refused (${res.status})`, res.status === 409 ? 409 : 502);
  return res;
}

async function keepToken(s: Pick<Services, "db">, id: string, token: string): Promise<void> {
  await updateSettings(s.db, (current) => ({ machines: current.machines.map((m) => (m.id === id ? { ...m, token } : m)) }));
}

/**
 * Lock a machine's ComfyUI, or change its lock: a new token (`renew`, or the first lock) and whether calls from its own
 * computer need one. Checked before it counts: a call without the token is refused, and one with it gets in. A lock that
 * does not hold is taken off again, never left half done. Said by Lock it, and by a rented pod coming up (rented.ts).
 */
export async function lockMachine(s: Pick<Services, "machines" | "db" | "queue">, id: string, body: { local: boolean; renew: boolean; origin?: string }): Promise<{ tokenEnd: string }> {
  const one = (await s.machines()).find((m) => m.machine.id === id);
  if (!one) throw httpError("there is no ComfyUI with that id", 404);
  const { machine, comfy } = one;
  const pack = await comfy.client.packVersion().catch(() => null);
  if (!pack || olderThan(pack, PACK_LOCK)) throw httpError(`The Afflatus node pack ${PACK_LOCK} or newer locks a ComfyUI: update the pack, restart ComfyUI, then lock it.`, 409);
  const before = machine.token;
  const token = before && !body.renew ? before : newToken();
  // the page that locked it is Afflatus's: with "from this PC", the pack lets that page in, and no other of this computer (lock.py)
  await post(comfy, "/afflatus/lock", { token, local: body.local, ...(body.origin ? { origin: body.origin } : {}) });
  comfy.client.token = token;
  const refused = await refusedWithout(comfy);
  const works = refused && (await comfy.client.status().then(() => true, () => false));
  if (!works) {
    // taken off again: a lock Afflatus cannot get through, or one that lets strangers in, is worse than none
    await post(comfy, "/afflatus/unlock", {}).catch(() => {});
    comfy.client.token = "";
    await keepToken(s, id, "");
    s.queue.events.emit("setup");
    throw httpError(refused ? "ComfyUI was locked, but did not answer with the token: it was opened again. Look at ComfyUI's console." : "ComfyUI still answered without the token, so it was opened again: is something in front of it (a proxy) that adds its own access?", 502);
  }
  await keepToken(s, id, token);
  s.queue.events.emit("setup");
  return { tokenEnd: token.slice(-4) };
}

export function registerLock(app: FastifyInstance, s: Services): void {
  const machineOf = async (id: string): Promise<MachineComfy> => {
    const one = (await s.machines()).find((m) => m.machine.id === id);
    if (!one) throw httpError("there is no ComfyUI with that id", 404);
    return one;
  };
  const told = () => s.queue.events.emit("setup");
  const params = z.object({ id: z.string().max(40) });
  const ip = (req: FastifyRequest) => req.socket.remoteAddress ?? "";

  /**
   * Lock it, or change its lock: a new token (`renew`, or the first lock) and whether calls from its own computer need one.
   * Checked before it counts: a call without the token is refused, and one with it gets in. A lock that does not hold is
   * taken off again, never left half done.
   */
  app.post("/api/machines/:id/lock", async (req) => {
    const { id } = params.parse(req.params);
    const { current, ...body } = z.object({ local: z.boolean().default(false), renew: z.boolean().default(false), current: z.string().max(200).optional() }).parse(req.body ?? {});
    // "No token needed from this PC" switched on loosens the lock, as unlocking does: a sign-in of the last 10 minutes or the
    // password (card #187). A lock it cannot read counts as one it would loosen
    if (body.local) {
      const was = await packLock((await machineOf(id)).comfy);
      if (!was || (was.locked && !was.local)) {
        await s.access.mayChange(req.access.session, current, ip(req));
        await s.access.audit(`ComfyUI ${id}: no token needed from its own computer, from ${ip(req)}`);
      }
    }
    const origin = /^https?:\/\/[^/\s]+$/i.test(req.headers.origin ?? "") ? req.headers.origin : undefined;
    const { tokenEnd } = await lockMachine(s, id, { ...body, origin });
    return { ok: true, checks: ["made", "locked", "refused", "answers"], tokenEnd };
  });

  /** Open it again: the lock taken off, the token forgotten. */
  app.post("/api/machines/:id/unlock", async (req) => {
    const { id } = params.parse(req.params);
    // it loosens what guards that ComfyUI as the Sign-in settings do: a sign-in of the last 10 minutes, or the password (a
    // session stolen long ago, or one signed out of nowhere yet, does not open it) (card #187)
    const { current } = z.object({ current: z.string().max(200).optional() }).parse(req.body ?? {});
    await s.access.mayChange(req.access.session, current, ip(req));
    const { comfy } = await machineOf(id);
    await post(comfy, "/afflatus/unlock", {});
    comfy.client.token = "";
    await keepToken(s, id, "");
    await s.access.audit(`ComfyUI ${id} unlocked, from ${ip(req)}`);
    told();
    return { ok: true };
  });

  /** A token made elsewhere (another Afflatus, a rented instance's start settings), pasted: kept only when it gets in. */
  app.post("/api/machines/:id/token", async (req) => {
    const { id } = params.parse(req.params);
    const { token } = z.object({ token: z.string().trim().min(16).max(200) }).parse(req.body);
    const { comfy } = await machineOf(id);
    const works = await new ComfyClient(comfy.client.baseUrl, undefined, token).status().then(() => true, () => false);
    if (!works) throw httpError("ComfyUI did not let that token in: it is not this ComfyUI's token.", 400);
    comfy.client.token = token;
    await keepToken(s, id, token);
    told();
    return { ok: true, tokenEnd: token.slice(-4) };
  });

  /**
   * The token itself, asked for on purpose (Copy token): for another tool that calls this ComfyUI. Only to a page on the
   * computer Afflatus runs on: Afflatus reached from another one (a LAN, a proxy) does not hand out the keys of its machines.
   */
  app.post("/api/machines/:id/token/copy", async (req) => {
    if (!fromThisComputer(req)) throw httpError("The token is copied on the computer Afflatus runs on, not from another one.", 403);
    const { id } = params.parse(req.params);
    const machine = (await readSettings(s.db)).machines.find((m) => m.id === id);
    if (!machine) throw httpError("there is no ComfyUI with that id", 404);
    if (!machine.token) throw httpError("This ComfyUI has no token: it is not locked by this Afflatus.", 409);
    // the token opens that ComfyUI as unlocking does: a sign-in of the last 10 minutes, or the password (card #187)
    const { current } = z.object({ current: z.string().max(200).optional() }).parse(req.body ?? {});
    await s.access.mayChange(req.access.session, current, ip(req));
    await s.access.audit(`ComfyUI ${id}: its token copied, from ${ip(req)}`);
    return { token: machine.token };
  });

  /** Where to open ComfyUI's own page (pageUrl). */
  app.post("/api/machines/:id/open", async (req) => {
    const { id } = params.parse(req.params);
    return { url: await pageUrl(s, (await machineOf(id)).comfy, loginKeyOf(req.access)) };
  });
}
