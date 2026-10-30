import { execFile } from "node:child_process";
import { connect } from "node:net";
import { freemem, totalmem } from "node:os";
import { onThisMachine } from "./modelDownload";
import { isPrivateHost } from "./outbound";
import type { Machine } from "./settings";

/**
 * Whether a ComfyUI that answers nothing still runs, told apart from one gone: a ComfyUI on a PC short of memory (paging)
 * answers no request for minutes while it samples on, and it was said offline and its render queued again (owner,
 * 2026-10-30). Its own process is what tells: the port it listens on still takes a connection (the system accepts it
 * whatever Python does), or, for a pod, RunPod says the pod runs and no death was said.
 */
export interface StillRuns {
  /** Its process lives: busy, not gone. */
  runs: boolean;
  /** What holds the memory, when this PC's: "ComfyUI holds 35.4 GB, 2.1 GB of 63.9 GB RAM free". Null when not known. */
  memory: string | null;
  /** This PC's RAM is all but full (under a tenth free): it pages, which is why ComfyUI answers nothing. */
  full: boolean;
  /** Its process holds more than this PC's RAM: only a restart gives that memory back. */
  swollen: boolean;
}

/** How long a connection to its port is waited for: a port closed refuses at once, a PC asleep or away never answers. */
const CONNECT_MS = 3_000;
/** How long the system is asked what the process holds (PowerShell is slow to start on a PC that pages). */
const MEMORY_ASK_MS = 15_000;
const GB = 1024 ** 3;

/**
 * Whether something listens on the port of an address: true once a connection is taken, false when refused (nothing
 * there: its process is dead), null when nothing answers in time (the machine away, asleep, or a firewall).
 */
export function portTakes(url: string, ms = CONNECT_MS): Promise<boolean | null> {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return Promise.resolve(null);
  }
  const port = Number(at.port || (at.protocol === "https:" ? 443 : 80));
  const host = at.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (said: boolean | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(said);
    };
    const timer = setTimeout(() => done(null), ms);
    socket.once("connect", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED" ? false : null));
  });
}

/**
 * What the process listening on a port of this PC holds, in bytes (its private memory, what it has had to page out
 * included): Windows only, through PowerShell, which the system has. Null anywhere else, or when it cannot be read.
 */
export function privateBytesOn(port: number, ms = MEMORY_ASK_MS): Promise<number | null> {
  if (process.platform !== "win32" || !Number.isInteger(port) || port <= 0) return Promise.resolve(null);
  const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1; (Get-Process -Id $c.OwningProcess -ErrorAction Stop).PrivateMemorySize64`;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: ms, windowsHide: true }, (err, out) => {
      const n = Number(String(out).trim());
      resolve(!err && Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

/** This PC's memory as words, with what the process holds when known ("ComfyUI holds 35.4 GB, 2.1 GB of 63.9 GB RAM free"). */
export function memorySaid(held: number | null, total = totalmem(), free = freemem()): string {
  const g = (n: number) => `${(n / GB).toFixed(1)} GB`;
  return `${held ? `ComfyUI holds ${g(held)}, ` : ""}${g(free)} of ${g(total)} RAM free`;
}

/**
 * Whether a machine's ComfyUI still runs (StillRuns). A pod: `podRuns` (rentedFollow, RunPod's word on it), never its
 * address, which is RunPod's proxy and takes a connection whether ComfyUI is there or not. A machine of the user's own: its
 * port, on this PC or its network only (an address out there may be a proxy too, which proves nothing). `memory`: what it
 * holds is read as well, when on this PC.
 */
export async function stillRuns(m: Machine, podRuns: ((machine: string) => boolean) | null, memory = true): Promise<StillRuns> {
  const none = { memory: null, full: false, swollen: false };
  if (m.rented) return { runs: Boolean(podRuns?.(m.id)), ...none };
  let host: string;
  try {
    host = new URL(m.url).hostname;
  } catch {
    return { runs: false, ...none };
  }
  if (!isPrivateHost(host) || (await portTakes(m.url)) !== true) return { runs: false, ...none };
  if (!memory || !onThisMachine(m.url)) return { runs: true, ...none };
  const held = await privateBytesOn(Number(new URL(m.url).port || 80)).catch(() => null);
  const total = totalmem();
  const free = freemem();
  return { runs: true, memory: memorySaid(held, total, free), full: free < total / 10, swollen: held !== null && held > total };
}
