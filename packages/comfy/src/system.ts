import type { ComfyStatus } from "./client";

/**
 * Load of the machine ComfyUI runs on, for the monitor bar. ComfyUI itself only reports memory
 * (/system_stats). CPU, GPU load, temperature and disks come from a monitor extension when one is
 * installed: it broadcasts a snapshot on the websocket about once a second, so listening costs nothing.
 * Every field but the GPU memory is optional: the bar shows what it has.
 */
export interface SystemLoad {
  at: number;
  /** Who reported it: an extension's live feed, or ComfyUI's own memory numbers. */
  source: "dasiwa" | "crystools" | "comfyui";
  /** Percent. */
  cpu?: number;
  ram?: { used: number; total: number; percent: number };
  /** Percent. */
  swap?: number;
  disks: Array<{ path: string; percent: number; readMbS?: number; writeMbS?: number }>;
  gpus: Array<{ name: string; load?: number; temperature?: number; vramUsed: number; vramTotal: number; vramPercent: number }>;
}

/** Extensions mark what they could not read with null, a negative number or a word. */
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const pct = (used: number | undefined, total: number | undefined) => (used !== undefined && total ? Math.round((used / total) * 1000) / 10 : 0);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);

function memory(v: unknown): SystemLoad["ram"] {
  const m = rec(v);
  const used = num(m.used);
  const total = num(m.total);
  return used !== undefined && total ? { used, total, percent: num(m.percent) ?? pct(used, total) } : undefined;
}

/** DaSiWa nodes: websocket message "dasiwa.system_monitor". */
function fromDasiwa(d: Rec): SystemLoad {
  return defined({
    at: Date.now(),
    source: "dasiwa" as const,
    cpu: num(d.cpu_percent),
    ram: memory(d.ram),
    swap: num(rec(d.swap).percent),
    disks: list(d.disks).flatMap((x) => {
      const percent = num(x.percent);
      return percent === undefined ? [] : [defined({ path: String(x.path ?? ""), percent, readMbS: num(x.read_mb_s), writeMbS: num(x.write_mb_s) })];
    }),
    gpus: list(d.gpus).map((g) => {
      const vramUsed = num(g.memory_used) ?? 0;
      const vramTotal = num(g.memory_total) ?? 0;
      return defined({
        name: String(g.name ?? "GPU"), load: num(g.utilization), temperature: num(g.temperature),
        vramUsed, vramTotal, vramPercent: num(g.memory_percent) ?? pct(vramUsed, vramTotal),
      });
    }),
  });
}

/** ComfyUI-Crystools: websocket message "crystools.monitor". */
function fromCrystools(d: Rec): SystemLoad {
  const ramUsed = num(d.ram_used);
  const ramTotal = num(d.ram_total);
  const hdd = num(d.hdd_used_percent);
  return defined({
    at: Date.now(),
    source: "crystools" as const,
    cpu: num(d.cpu_utilization),
    ram: ramUsed !== undefined && ramTotal ? { used: ramUsed, total: ramTotal, percent: num(d.ram_used_percent) ?? pct(ramUsed, ramTotal) } : undefined,
    disks: hdd === undefined ? [] : [{ path: "", percent: hdd }],
    gpus: list(d.gpus).map((g, i) => {
      const vramUsed = num(g.vram_used) ?? 0;
      const vramTotal = num(g.vram_total) ?? 0;
      return defined({
        name: `GPU ${i}`, load: num(g.gpu_utilization), temperature: num(g.gpu_temperature),
        vramUsed, vramTotal, vramPercent: num(g.vram_used_percent) ?? pct(vramUsed, vramTotal),
      });
    }),
  });
}

/** A websocket message → a load snapshot, or null when it isn't one. */
export function systemLoadFrom(type: string | undefined, data: unknown): SystemLoad | null {
  if (type === "dasiwa.system_monitor") return fromDasiwa(rec(data));
  if (type === "crystools.monitor") return fromCrystools(rec(data));
  return null;
}

/** The fallback when no extension reports: what ComfyUI's own status says, GPU memory only. */
export function systemLoadFromStatus(s: ComfyStatus): SystemLoad {
  const used = Math.max(0, s.vramTotal - s.vramFree);
  return {
    at: Date.now(), source: "comfyui", disks: [],
    gpus: s.vramTotal ? [{ name: s.device, vramUsed: used, vramTotal: s.vramTotal, vramPercent: pct(used, s.vramTotal) }] : [],
  };
}
