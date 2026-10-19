import { costs, PARTS, type CostsView } from "./costs";
import { readSettings } from "./settings";
import type { Services } from "./services";

/**
 * The money side of /metrics: what the rented GPUs cost, as Queue › Costs works it out (costs.ts), for a dashboard beside
 * the render figures. Spend by part and by GPU and the pods' ends by reason are counters over the whole record (they only
 * grow, until the record is forgotten); the day, the month, the caps, the balance, the pace and storage are gauges.
 * Nothing is said without a RunPod key, a rented machine or a pod session on record. Labels are the part, RunPod's GPU
 * name and the end's reason: never a pod's id, which is new at each deploy.
 */

/** The Costs view of the whole record is worked out at most this often: a scraper asks every few seconds, RunPod is read once a minute. */
const FRESH_MS = 60_000;

type Line = (name: string, labels: Record<string, string>, value: number) => void;
type Head = (name: string, type: "counter" | "gauge", help: string) => void;

export function costMetrics(s: Services): (head: Head, put: Line) => Promise<void> {
  let kept: { at: number; value: Promise<CostsView> } | null = null;
  const view = (): Promise<CostsView> => {
    if (kept && Date.now() - kept.at < FRESH_MS) return kept.value;
    const value = (async () => {
      const settings = await readSettings(s.db);
      const spending = settings.runpodKey || settings.machines.some((m) => m.rented) ? await s.rented.spending().catch(() => null) : null;
      return costs({
        db: s.db, registry: s.registry, settings, spending, billReadAt: s.rented.billRead?.ok ? s.rented.billRead.at : null,
        costBetween: (from, to) => s.rented.costBetween(from, to),
        offers: async () => null,
      }, {});
    })();
    kept = { at: Date.now(), value };
    value.catch(() => { kept = null; });
    return value;
  };

  return async (head, put) => {
    const settings = await readSettings(s.db);
    const sessions = await s.db.selectFrom("rent_sessions").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    if (!settings.runpodKey && !settings.machines.some((m) => m.rented) && !Number(sessions.n)) return;
    const v = await view().catch(() => null);
    if (!v) return;

    head("afflatus_rented_spend_usd_total", "counter", "What the rented GPUs cost, USD, by what the pods did (Queue › Costs's parts)");
    for (const part of PARTS) put("afflatus_rented_spend_usd_total", { part }, v.where.usd[part]);
    const byGpu = new Map<string, number>();
    for (const x of v.sessions) byGpu.set(x.gpu ?? "unknown", (byGpu.get(x.gpu ?? "unknown") ?? 0) + x.usd);
    head("afflatus_rented_gpu_spend_usd_total", "counter", "What the rented GPUs cost, USD, by RunPod's GPU");
    for (const [gpu, usd] of byGpu) put("afflatus_rented_gpu_spend_usd_total", { gpu }, usd);

    const ends = await s.db.selectFrom("rent_sessions").select(["end_why", (eb) => eb.fn.countAll<number>().as("n")]).where("ended_at", "is not", null).groupBy("end_why").execute();
    head("afflatus_rented_pod_ends_total", "counter", "Pod runs that ended, by why: idle, cap, you, crash…; unknown when RunPod ended it or the run is from before");
    for (const e of ends) put("afflatus_rented_pod_ends_total", { reason: e.end_why ?? "unknown" }, Number(e.n));
    const open = await s.db.selectFrom("rent_sessions").select((eb) => eb.fn.countAll<number>().as("n")).where("ended_at", "is", null).executeTakeFirstOrThrow();
    head("afflatus_rented_pods_running", "gauge", "Rented pods running now (a pod session open)");
    put("afflatus_rented_pods_running", {}, Number(open.n));

    head("afflatus_rented_spend_today_usd", "gauge", "Today's compute on rented pods, USD: what the day cap is weighed against");
    put("afflatus_rented_spend_today_usd", {}, v.today.usd);
    head("afflatus_rented_spend_month_usd", "gauge", "This month's whole RunPod bill, USD (pods, stopped disks, volumes): what the month cap is weighed against");
    put("afflatus_rented_spend_month_usd", {}, v.month);
    head("afflatus_rented_cap_usd", "gauge", "The spending caps, USD; 0 is none");
    put("afflatus_rented_cap_usd", { period: "day" }, v.caps.day);
    put("afflatus_rented_cap_usd", { period: "month" }, v.caps.month);
    if (v.balance !== null) {
      head("afflatus_runpod_balance_usd", "gauge", "RunPod's balance, USD, as last read");
      put("afflatus_runpod_balance_usd", {}, v.balance);
    }
    if (v.spendPerHr !== null) {
      head("afflatus_rented_spend_per_hour_usd", "gauge", "What the account spends an hour now, USD, as RunPod says it");
      put("afflatus_rented_spend_per_hour_usd", {}, v.spendPerHr);
    }
    if (v.storage) {
      head("afflatus_rented_storage_month_usd", "gauge", "What storage bills a month as the account stands, USD: network volumes and stopped pods' disks");
      put("afflatus_rented_storage_month_usd", {}, v.storage.perMonth);
      head("afflatus_rented_storage_items", "gauge", "What storage bills for: network volumes, and stopped pods keeping their disk");
      put("afflatus_rented_storage_items", { kind: "volumes" }, v.storage.volumes);
      put("afflatus_rented_storage_items", { kind: "stopped_disks" }, v.storage.stoppedDisks);
    }
  };
}
