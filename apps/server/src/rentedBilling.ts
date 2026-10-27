import { httpError } from "./errors";
import { HOURS_A_MONTH, STOPPED_DISK_PER_GB_MONTH, type BillRecord, type VolumeBill } from "./runpod";
import { gpuKey, LEARNED_RENDERS, volumePerMonth } from "@afflatus/core";
import { gpuPaces } from "./forecast";
import { keptHoldings, noticeVolumes, viewVolumes, type Storage } from "./rentedVolumes";
import { dollars } from "./notifyWords";
import { readSettings, type Machine } from "./settings";
import { RentedCore } from "./rentedModel";

export interface Spending {
  /**
   * Today's compute, weighed against the day cap: the pods while they run, not a stopped pod's disk (an hour of RunPod's
   * bill with no run of that pod in Afflatus counts without its disk), not the network volumes.
   */
  today: number;
  /** This month's whole bill, weighed against the month cap: the pods, stopped pods' disks and the network volumes. */
  month: number;
  /** Of `month`, the network volumes' bill (null when RunPod did not give it: not in `month` then). */
  monthVolumes: number | null;
  caps: { day: number; month: number };
  /** The account's balance on RunPod, when it says it (asked at most once a minute). */
  balance: number | null;
  /** Under this, the card says the balance is low: RunPod stops pods at zero. */
  lowBalance: boolean;
  /** What the account spends an hour now on RunPod (every pod and volume), when it says it. */
  spendPerHr: number | null;
  /** How long the balance lasts at that spend (ms); null when nothing is spent, or RunPod did not say. */
  runwayMs: number | null;
  /**
   * What a day costs at this pace (USD): the pods, as Afflatus counted them over the last 7 days, and storage (the volumes
   * and the pods' own disks, as the account stands), which bills every day whether anything runs or not.
   */
  perDay: { pods: number; storage: number };
  /** How long the balance lasts at that pace (days); null without a balance, or with nothing spent. */
  runwayDays: number | null;
  /** Today and this month are RunPod's own bill (with Afflatus's count for the hours RunPod has not billed yet); false: Afflatus's count alone. */
  billed: boolean;
  /** What storage costs (volumes, the pods' own disks); null when RunPod was not read. In the month cap, never in the day cap. */
  storage: Storage | null;
}

/**
 * What a pod cost as Afflatus counts it (rent_sessions), today and this month, whether a run of it is still open, and its
 * runs this month (ms): an hour of RunPod's bill outside all of them was a stopped pod's disk alone.
 */
type Counted = { today: number; month: number; open: boolean; lastEnd: number; runs: Array<{ start: number; end: number }> };

const LOW_BALANCE = 5;
/** The balance is told of as low under this at least (notify.ts), and under a day of the last week's spend when that is more. */
const LOW_LINE = 2;
export const HOUR = 3_600_000;
/** How often RunPod's bill is read again: it is written some hours after the fact, nothing is lost reading it seldom. */
const BILL_EVERY_MS = 5 * 60_000;
/**
 * A pod whose last run ended this long ago is billed in full by RunPod: its bill is its cost. Before, the higher of RunPod's
 * bill and Afflatus's count (which counts from the deploy, and to the latest a pod could have run), so that a cap is never
 * reached late.
 */
const BILL_SETTLED_MS = 6 * HOUR;

/** What is kept back of the balance when a job's length is weighed against it: a render is not started into the last minutes. */
const RUNWAY_MARGIN_MS = 10 * 60_000;
/**
 * A job's forecast on a pod that rests on too little of its own is weighed against the balance at this many times: a new
 * pod's forecast read from another machine's renders came out at half its truth (a 2000 Ada told 9.8 min took 21.5), and
 * a render the balance runs out under is lost, and paid.
 */
const UNSURE_FORECAST = 1.5;
/** The renders of a recipe a pod needs of its own before its forecast there is weighed as it is. */
const SURE_RENDERS = 3;
/** How long what the record says of the pods' forecasts (their own renders, the GPUs' paces) is kept before it is read again. */
const SURE_FRESH_MS = 60_000;

/**
 * What a job with no forecast at all is taken to render for, against the balance: a render nothing like it was made yet
 * (LTX 2.5's first) went to a pod whatever the balance, and one the balance runs out under is lost, and paid.
 */
const UNKNOWN_RENDER_MS = 30 * 60_000;

/**
 * What a job needs of the balance on a pod, beside the margin (ms): its files still to come, then its render, half again
 * when its forecast there is not `sure`, UNKNOWN_RENDER_MS when it has none (null). A fetch that cannot be told (a file
 * with no source) counts nothing: that job never starts there for its files, whatever the balance.
 */
export function runwayNeed(o: { renderMs: number | null; fetchMs: number; sure: boolean }): number {
  const render = o.renderMs === null ? UNKNOWN_RENDER_MS : o.renderMs * (o.sure ? 1 : UNSURE_FORECAST);
  return (Number.isFinite(o.fetchMs) ? Math.max(0, o.fetchMs) : 0) + render;
}
/**
 * What a run (its start and end, ms, at `rate` an hour) cost over its part from `from` to `to` (ms), as Afflatus counts it:
 * 0 when they do not overlap or a time could not be read. The batch notice, the 7-day pace and the caps all count by it.
 */
function runCost(start: number, end: number, rate: number, from: number, to = Infinity): number {
  const a = Math.max(from, start);
  const b = Math.min(to, end);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? ((b - a) / HOUR) * rate : 0;
}
/**
 * The share of a record of RunPod's bill (an hour of a pod) that falls between two moments (ms), by its time: a record
 * across midnight or the 1st (an hour of the bill is UTC's, a day here is the user's) is cut there, not given whole to the
 * day or the month it starts in. A record of no length counts whole where it starts.
 */
export function shareIn(r: { start: number; end: number }, from: number, to: number): number {
  if (!(r.end > r.start)) return r.start >= from && r.start < to ? 1 : 0;
  return Math.max(0, Math.min(to, r.end) - Math.max(from, r.start)) / (r.end - r.start);
}

/** Whether a cap is reached by what was spent: today's at the day's, this month's at the month's (0: no cap). */
export const capReached = (caps: { day: number; month: number }, spent: { today: number; month: number }): boolean =>
  (caps.day > 0 && spent.today >= caps.day) || (caps.month > 0 && spent.month >= caps.month);

/**
 * What rented pods cost (rented.ts): RunPod's balance and bill, the spending of today and of the month against the caps,
 * the runway a render needs, and the storage billed while pods are stopped. Told of when a cap or a low balance is reached.
 */
export class RentedBilling extends RentedCore {
  private balanceSeen: { at: number; value: number | null; spendPerHr: number | null } | null = null;
  /**
   * RunPod's bill since the start of the month, as last asked (`at`): the records of its last good read of that month
   * (`readAt`), kept when a read fails (null: RunPod never gave it this month).
   */
  private billSeen: { at: number; from: number; records: BillRecord[] | null; readAt: number | null } | null = null;

  /** RunPod's reads under way, by what they read: a second ask while one is out waits for it rather than asking again. */
  private asking = new Map<string, Promise<unknown>>();

  /** The caps already told of as reached, by cap and period ("day:2026-10-14"): once a day, once a month. */
  private capsTold = new Set<string>();
  /** The balance was told of as low: not again until it is back over the line. */
  private lowTold = false;

  /**
   * How long RunPod's balance lasts at what the account spends now (ms), as last read; null when it is not known (a job is
   * not held back then). At zero RunPod stops every pod: a render longer than this is not sent to a rented one.
   */
  runwayMs(): number | null {
    const b = this.balanceSeen;
    if (!b || b.value === null || !b.spendPerHr || b.spendPerHr <= 0) return null;
    return Math.max(0, (b.value / b.spendPerHr) * HOUR - (this.now() - b.at));
  }

  private sureKept: { at: number; own: Map<string, number>; paced: Set<string> } | null = null;

  /**
   * Whether a job's forecast on this pod is weighed against the balance as it is: the pod rendered its recipe SURE_RENDERS
   * times, or its GPU's pace is learned (the forecast then reads that GPU's renders, or others' at its pace).
   */
  private async forecastSure(machine: string, recipeId: string): Promise<boolean> {
    if (!this.sureKept || this.now() - this.sureKept.at > SURE_FRESH_MS) {
      const own = await this.db
        .selectFrom("render_stats")
        .select(["machine_id", "recipe_id", (eb) => eb.fn.countAll<number>().as("n")])
        .where("status", "=", "done")
        .where("whole", "=", 1)
        .where("machine_id", "is not", null)
        .groupBy(["machine_id", "recipe_id"])
        .execute();
      const paced = (await gpuPaces(this.db)).filter((g) => g.renders >= LEARNED_RENDERS && g.pace > 0).map((g) => gpuKey(g.gpu));
      this.sureKept = { at: this.now(), own: new Map(own.map((r) => [`${r.machine_id}\n${r.recipe_id}`, Number(r.n)])), paced: new Set(paced) };
    }
    if ((this.sureKept.own.get(`${machine}\n${recipeId}`) ?? 0) >= SURE_RENDERS) return true;
    const gpu = this.seen.get(machine)?.pod?.gpu;
    return Boolean(gpu && this.sureKept.paced.has(gpuKey(gpu)));
  }

  /** What a job of this recipe needs of the balance on this pod (`runwayNeed`), its render forecast there and its files' time to come given (ms). */
  async balanceNeed(machine: string, recipeId: string, renderMs: number, fetchMs: number): Promise<number> {
    return runwayNeed({ renderMs, fetchMs, sure: await this.forecastSure(machine, recipeId) });
  }

  /** Whether a job of this length may be sent to a rented pod now: it ends before the balance does, with a margin. */
  fitsBalance(ms: number | null): { ok: boolean; leftMs: number | null } {
    const left = this.runwayMs();
    if (left === null || ms === null) return { ok: true, leftMs: left };
    return { ok: ms + RUNWAY_MARGIN_MS <= left, leftMs: left };
  }

  /** The balance and what is spent an hour, read again at most once a minute. */
  protected async readBalance(key: string): Promise<void> {
    if (this.now() < this.quietUntil || (this.balanceSeen && this.now() - this.balanceSeen.at <= 60_000)) return;
    return this.once("balance", async () => {
      const got = await this.client(key).balance().catch(() => ({ balance: null, spendPerHr: null }));
      this.balanceSeen = { at: this.now(), value: got.balance, spendPerHr: got.spendPerHr };
      if (got.balance !== null) await this.sayBalance(got.balance, key).catch((err: Error) => console.warn(`[rented] the balance's line not worked out: ${err.message}`));
    });
  }

  /**
   * The balance told of as low once it is under the higher of $2 and a day at this pace (`perDay`: the last week's pods and
   * the storage there is now): what one more such day would leave at zero, when RunPod stops every pod. Once, until it is
   * back over the line.
   */
  private async sayBalance(balance: number, key: string): Promise<void> {
    if (!this.tell) return;
    const pace = await this.perDay(key);
    const line = Math.max(LOW_LINE, pace.pods + pace.storage);
    if (balance >= line) {
      this.lowTold = false;
      return;
    }
    if (this.lowTold) return;
    this.lowTold = true;
    const said = line > LOW_LINE ? `, a day at this pace (the last week's pods ${dollars(pace.pods)}, storage ${dollars(pace.storage)})` : "";
    this.tell("balanceLow", { title: `RunPod balance low: ${dollars(balance)}`, body: `Under ${dollars(line)}${said}. At $0 RunPod stops every pod, a render under way too.`, key: "balance" });
  }

  /**
   * What a day costs at this pace: the pods as Afflatus counted them over the last 7 days, a seventh of it, and storage as
   * the account stands (its price a month, billed by the hour over HOURS_A_MONTH). Storage is 0 when RunPod's volumes and
   * pods were not read.
   */
  private async perDay(key: string): Promise<{ pods: number; storage: number }> {
    const now = this.now();
    const pods = (await this.costBetween(now - 7 * 24 * HOUR, now)) / 7;
    const storage = key ? await this.storage(key) : null;
    return { pods, storage: storage ? (storage.nowMonth * 24) / HOURS_A_MONTH : 0 };
  }

  /** A day's or a month's cap reached: told once for that day, once for that month. */
  protected sayCap(caps: { day: number; month: number }, spent: { today: number; month: number }): void {
    if (!this.tell) return;
    const d = new Date(this.now());
    const reached = [
      { key: `day:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, cap: caps.day, spent: spent.today, said: "Today's", also: "" },
      // the month's is the whole bill, the volumes in it: a volume made or grown is refused at it too (monthCapped)
      { key: `month:${d.getFullYear()}-${d.getMonth() + 1}`, cap: caps.month, spent: spent.month, said: "This month's", also: " Make volume and Grow are refused too." },
    ];
    for (const r of reached) {
      if (r.cap <= 0 || r.spent < r.cap || this.capsTold.has(r.key)) continue;
      this.capsTold.add(r.key);
      this.tell("capReached", { title: `${r.said} cap reached: ${dollars(r.spent)} of ${dollars(r.cap)}`, body: `The rented GPUs stop once their render ends, and Start is refused until the cap is raised or the period ends.${r.also}`, key: r.key });
    }
  }

  /** What the pod's last run cost as Afflatus counts it (its time × its rate), to now while it is still open; null before any. */
  protected async lastRunCost(m: Machine): Promise<number | null> {
    const r = await this.db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where("machine_id", "=", m.id).orderBy("started_at", "desc").executeTakeFirst();
    if (!r) return null;
    const end = r.ended_at ? Date.parse(r.ended_at) : this.now();
    return Math.max(0, ((end - Date.parse(r.started_at)) / HOUR) * r.rate);
  }

  /** What the rented GPUs cost between two moments (ms), as Afflatus counts it (rent_sessions): a batch of renders' notice says it. */
  costBetween(from: number, to: number): Promise<number> {
    return this.sessionsCost(from, to, from);
  }

  /**
   * What the rented GPUs cost for a batch of renders that ran from `from` to `to` (ms), as Afflatus counts it: every run that
   * overlaps it, from its own start (its boot and its files, which the batch's first render on it waited for, are the
   * batch's) but never from before `notBefore` (the end of the batch before, which counted that), to `to`.
   */
  batchCost(from: number, to: number, notBefore: number): Promise<number> {
    return this.sessionsCost(from, to, notBefore);
  }

  /** The runs that overlap `from` to `to` (ms), each counted from `startFloor` (or its own start, if later) to `to`, an open one to `to`. */
  private async sessionsCost(from: number, to: number, startFloor: number): Promise<number> {
    const rows = await this.db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", new Date(from).toISOString())])).where("started_at", "<", new Date(to).toISOString()).execute();
    return rows.reduce((sum, r) => sum + runCost(Date.parse(r.started_at), r.ended_at ? Date.parse(r.ended_at) : to, r.rate, startFloor, to), 0);
  }

  /**
   * RunPod's bill over each stretch of a chart (`times`, each `step` long), every pod of the account, a record across two
   * stretches shared between them by its time. Null for a stretch before this month (the bill read starts there), and for
   * all of them when RunPod did not give it. The Costs tab sets it against Afflatus's count, stretch by stretch.
   */
  async billedIn(times: readonly number[], step: number): Promise<Array<number | null>> {
    const key = (await readSettings(this.db)).runpodKey;
    const d = new Date(this.now());
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const records = key ? await this.bill(key, month) : null;
    if (!records) return times.map(() => null);
    return times.map((t) => (t < month ? null : records.reduce((n, r) => n + r.amount * shareIn(r, t, t + step), 0)));
  }

  /** When the bill in use was read (ms), and whether RunPod gave one: the Costs tab says how old its totals are. */
  get billRead(): { at: number; ok: boolean } | null {
    const seen = this.billSeen;
    return seen ? { at: seen.readAt ?? seen.at, ok: seen.records !== null } : null;
  }

  /**
   * RunPod's bill since `from` (ms), read again every few minutes; null when RunPod does not give it. A read that fails
   * keeps the month's last records read, as the volumes' bill does: a month cap is never let go for one refused read.
   */
  private async bill(key: string, from: number): Promise<BillRecord[] | null> {
    const seen = this.billSeen;
    if (seen && seen.from === from && (this.now() - seen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return seen.records;
    return this.once(`bill:${from}`, async () => {
      const records = await this.client(key).billing(from, this.now()).catch((err: Error) => {
        console.warn(`[rented] RunPod's bill not read: ${err.message}`);
        return null;
      });
      const kept = seen?.from === from ? seen : null;
      this.billSeen = records ? { at: this.now(), from, records, readAt: this.now() } : { at: this.now(), from, records: kept?.records ?? null, readAt: kept?.readAt ?? null };
      return this.billSeen.records;
    });
  }

  private volumeBillSeen: { at: number; from: number; records: VolumeBill[] | null } | null = null;

  /**
   * RunPod's bill of the network volumes since `from`, by the day, read again at most every few minutes as the pods' bill
   * is. A read that fails keeps the month's last records read: a month cap is never let go for one refused read.
   */
  private async volumeBill(key: string, from: number): Promise<VolumeBill[] | null> {
    const seen = this.volumeBillSeen;
    if (seen && seen.from === from && (this.now() - seen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return seen.records;
    return this.once(`volumeBill:${from}`, async () => {
      const records = await this.client(key).volumeBilling(from, this.now()).catch((err: Error) => {
        console.warn(`[rented] RunPod's bill of the volumes not read: ${err.message}`);
        return null;
      });
      const kept = records ?? (seen?.from === from ? seen.records : null);
      this.volumeBillSeen = { at: this.now(), from, records: kept };
      return kept;
    });
  }

  /** One read of RunPod at a time for each thing read: the spending reads its bill, balance and storage together, and storage reads the bill too. */
  private once<T>(what: string, read: () => Promise<T>): Promise<T> {
    const out = this.asking.get(what);
    if (out) return out as Promise<T>;
    const value = read().finally(() => this.asking.delete(what));
    this.asking.set(what, value);
    return value;
  }

  /** What each pod cost since `month` as Afflatus counts it, and since `today` (rent_sessions). */
  private async counted(month: number, today: number): Promise<Map<string, Counted>> {
    const rows = await this.db.selectFrom("rent_sessions").selectAll().where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", new Date(month).toISOString())])).execute();
    const now = this.now();
    const out = new Map<string, Counted>();
    for (const r of rows) {
      const start = Date.parse(r.started_at);
      const end = r.ended_at ? Date.parse(r.ended_at) : now;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const c = out.get(r.pod) ?? { today: 0, month: 0, open: false, lastEnd: 0, runs: [] };
      c.runs.push({ start, end });
      c.month += runCost(start, end, r.rate, month);
      c.today += runCost(start, end, r.rate, today);
      c.open ||= !r.ended_at;
      c.lastEnd = Math.max(c.lastEnd, end);
      out.set(r.pod, c);
    }
    return out;
  }

  /**
   * Today's and this month's cost of the rented GPUs: RunPod's own bill (its GPU and its disk, every pod of the account) for a
   * pod it has billed in full; for one that runs, or ran a short while ago, the higher of RunPod's bill so far and Afflatus's
   * count. A cap is never reached late, and the figures end as RunPod's. Afflatus's count alone when RunPod's bill is not read.
   * The two caps weigh different things, as the owner chose: the day cap is compute, so today leaves out a stopped pod's
   * disk (a 150 GB disk bills about $1 a day: a $1 day cap would be reached with nothing running, and Start refused); the
   * month cap is everything RunPod bills, so the month has the stopped disks and the network volumes' bill too.
   */
  protected async spent(): Promise<{ today: number; month: number; monthVolumes: number | null; billed: boolean }> {
    const d = new Date(this.now());
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const counted = await this.counted(month, today);
    const key = (await readSettings(this.db)).runpodKey;
    const records = key ? await this.bill(key, month) : null;
    const billed = new Map<string, { today: number; month: number }>();
    // a record across midnight or the 1st counts for its part after it (shareIn)
    for (const r of records ?? []) {
      if (r.end <= month) continue;
      const b = billed.get(r.pod) ?? { today: 0, month: 0 };
      b.month += r.amount * shareIn(r, month, Infinity);
      // an hour no run of this pod was in: the pod was stopped (or not started yet), and what it billed then was its disk
      const ran = counted.get(r.pod)?.runs.some((x) => x.end > r.start && x.start < Math.max(r.end, r.start + 1)) ?? false;
      b.today += (ran ? r.amount : Math.max(0, r.amount - r.disk)) * shareIn(r, today, Infinity);
      billed.set(r.pod, b);
    }
    let sumToday = 0;
    let sumMonth = 0;
    for (const pod of new Set([...counted.keys(), ...billed.keys()])) {
      const c = counted.get(pod);
      const b = billed.get(pod);
      const settled = b && (!c || (!c.open && this.now() - c.lastEnd > BILL_SETTLED_MS));
      sumToday += settled ? b.today : Math.max(b?.today ?? 0, c?.today ?? 0);
      sumMonth += settled ? b.month : Math.max(b?.month ?? 0, c?.month ?? 0);
    }
    const volumeBills = key ? await this.volumeBill(key, month) : null;
    const monthVolumes = volumeBills ? volumeBills.reduce((n, r) => n + (r.end > month ? r.amount * shareIn(r, month, Infinity) : 0), 0) : null;
    return { today: sumToday, month: sumMonth + (monthVolumes ?? 0), monthVolumes, billed: records !== null };
  }

  /** Refused at a reached month cap: a volume made or grown bills every month (the day cap is compute only, it is not asked). */
  protected async monthCapped(): Promise<void> {
    const cap = (await readSettings(this.db)).rentCaps.month;
    if (cap <= 0) return;
    const spent = await this.spent();
    if (spent.month >= cap) throw httpError(`This month's cap is reached (${dollars(spent.month)} of ${dollars(cap)}), and a network volume bills every month: raise the cap in Settings › Rented GPUs first.`, 409);
  }

  /** Whether a spending cap is reached now: a deploy and a Start are refused, and the GPU hunt ends (hunt.ts). */
  async capped(): Promise<boolean> {
    const caps = (await readSettings(this.db)).rentCaps;
    if (caps.day <= 0 && caps.month <= 0) return false;
    return capReached(caps, await this.spent());
  }

  /** Today's and this month's cost, the caps, RunPod's balance, and what storage costs. */
  async spending(): Promise<Spending> {
    const s = await readSettings(this.db);
    // RunPod is asked at most once a minute: the card reads this every 10 s while a pod runs. Its bill, balance and storage
    // are read together: one after the other they kept Queue › Costs waiting for three answers of RunPod's in a row
    const [spent, , storage] = await Promise.all([this.spent(), s.runpodKey ? this.readBalance(s.runpodKey) : undefined, s.runpodKey ? this.storage(s.runpodKey) : null]);
    const balance = this.balanceSeen?.value ?? null;
    // the one runway said everywhere (Settings, Queue › Costs): the balance over a day at this pace, storage in it
    const perDay = await this.perDay(s.runpodKey);
    const day = perDay.pods + perDay.storage;
    return {
      ...spent, caps: s.rentCaps, balance, lowBalance: balance !== null && balance < Math.max(LOW_BALANCE, day), spendPerHr: this.balanceSeen?.spendPerHr ?? null, runwayMs: this.runwayMs(),
      perDay, runwayDays: balance !== null && day > 0 ? Math.max(0, balance) / day : null, storage,
    };
  }

  protected storageSeen: { at: number; value: Storage | null } | null = null;

  /**
   * What storage costs on the account: the volumes' bill this month, the pods' own disks within this month's bill, and
   * what it all costs a month as it stands. Read again every few minutes (it moves by the day); null when RunPod does not
   * answer.
   */
  private async storage(key: string): Promise<Storage | null> {
    if (this.storageSeen && (this.now() - this.storageSeen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return this.storageSeen.value;
    return this.once("storage", () => this.readStorage(key));
  }

  /** Storage as RunPod says it now: its volumes, its pods' disks and their bills this month. */
  private async readStorage(key: string): Promise<Storage | null> {
    const d = new Date(this.now());
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const client = this.client(key);
    const [volumes, pods, volumeBills, podBills] = await Promise.all([
      client.volumes().catch(() => null),
      client.pods().catch(() => null),
      this.volumeBill(key, month),
      this.bill(key, month),
    ]);
    let value: Storage | null = null;
    if (volumes && pods) {
      const disks = pods.filter((p) => p.status !== "TERMINATED" && p.diskGb > 0);
      const kept = await keptHoldings(this.db);
      await noticeVolumes(this.db, volumes, kept, this.now());
      const settings = await readSettings(this.db);
      const unused = viewVolumes(volumes, pods, settings.machines, await keptHoldings(this.db), settings.volumeUnusedDays, this.now()).filter((v) => v.unused);
      value = {
        volumesMonth: volumeBills ? volumeBills.filter((b) => b.end > month).reduce((n, b) => n + b.amount, 0) : null,
        disksMonth: (podBills ?? []).reduce((n, r) => n + r.disk * shareIn(r, month, Infinity), 0),
        // what bills with nothing running: a running pod's own disk is in its rate (runningRate) while it runs, and bills
        // at the stopped price once it stops; its container disk goes at the stop
        perMonth: volumes.reduce((n, v) => n + volumePerMonth(v.size), 0) + disks.reduce((n, p) => n + p.diskGb * STOPPED_DISK_PER_GB_MONTH, 0),
        // the runway's storage: a running pod's disk is billed in its rate, already in the pods' pace, and is not counted twice
        nowMonth: volumes.reduce((n, v) => n + volumePerMonth(v.size), 0) + disks.filter((p) => p.status === "EXITED").reduce((n, p) => n + p.diskGb * STOPPED_DISK_PER_GB_MONTH, 0),
        volumes: volumes.length,
        stoppedDisks: disks.filter((p) => p.status === "EXITED").length,
        unused: unused.map((v) => ({ id: v.id, name: v.name, perMonth: v.perMonth, usedAt: v.usedAt })),
      };
    }
    this.storageSeen = { at: this.now(), value };
    return value;
  }
}
