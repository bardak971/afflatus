import { createHmac } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { HERE_LOGIN, OPEN_LOGIN, type Access } from "./access";
import type { Comfy, MachineComfy } from "./comfy";

/**
 * ComfyUI logins tied to Afflatus's sign-ins. Open ComfyUI gives the browser a login of the node pack's lock (lock.py)
 * named after the Afflatus sign-in that asked for it; Afflatus tells each locked ComfyUI which logins are still good, so
 * that signing a device out, Sign out everywhere, a new password or a sign-in's own end ends its ComfyUI login too.
 * ComfyUI is told, never asks: a rented pod does not reach the computer Afflatus runs on. Told at once on every change of
 * Access (a session ended, the password set or changed, "From this computer" turned off) and every minute besides (Access
 * says "changed" every minute), which also brings back a ComfyUI that did not answer: lock.py refuses a login it has not
 * heard named for 10 minutes (its LEASE_S).
 */

/** What a request's ComfyUI login is opened under: its session, or (with none) this computer's or no password's. */
export const loginKeyOf = (a: FastifyRequest["access"]): string => a.session ?? (a.locked ? HERE_LOGIN : OPEN_LOGIN);

/**
 * A login's id as a ComfyUI sees it: an HMAC of what it was opened under, keyed by that machine's token, so that a ComfyUI
 * (a rented pod, whoever runs it) learns nothing of the sessions, nor ties one machine's logins to another's.
 */
export const loginId = (token: string, key: string): string => createHmac("sha256", token).update(`afflatus-comfy-login:${key}`).digest("hex").slice(0, 32);

/** The login to open under `key` and the logins still good, as a ComfyUI locked with `token` names them; null when `key` is not good. */
export async function loginsFor(access: Pick<Access, "comfyLoginKeys">, token: string, key: string): Promise<{ login: string; keep: string[] } | null> {
  const keys = await access.comfyLoginKeys();
  if (!keys.includes(key)) return null;
  return { login: loginId(token, key), keep: keys.map((k) => loginId(token, k)) };
}

/** Tell one locked ComfyUI the logins still good. A pack before the logins (404, 405) or a ComfyUI that does not answer: let be. */
async function tell(comfy: Comfy, keys: string[]): Promise<void> {
  const token = comfy.client.token;
  if (!token) return;
  const res = await comfy.client.raw("/afflatus/logins", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep: keys.map((k) => loginId(token, k)) }), signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  await res?.body?.cancel().catch(() => {});
}

/**
 * Keep every locked ComfyUI told of the logins still good: at once, on each change of Access, and every minute with it.
 * One round at a time; a change during one runs another after it. A rented pod that is down is not called (`down`).
 */
export function followComfyLogins(opts: { access: Access; machines: () => Promise<MachineComfy[]>; down?: (id: string) => boolean }): { stop(): void; settled(): Promise<void> } {
  let running: Promise<void> | null = null;
  let again = false;
  const round = async () => {
    const keys = await opts.access.comfyLoginKeys();
    const all = (await opts.machines()).filter(({ machine, comfy }) => comfy.client.token && !opts.down?.(machine.id));
    await Promise.all(all.map(({ comfy }) => tell(comfy, keys)));
  };
  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = round().catch((err: Error) => console.warn(`[comfy logins] ${err.message}`)).finally(() => {
      running = null;
      if (again) {
        again = false;
        kick();
      }
    });
  };
  opts.access.on("changed", kick);
  kick();
  return {
    stop: () => void opts.access.off("changed", kick),
    settled: async () => {
      while (running) await running;
    },
  };
}
