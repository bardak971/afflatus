import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { plural } from "@afflatus/core";
import type { Db } from "./db";
import { httpError } from "./errors";
import type { Notify } from "./notify";
import { readSettings, updateSettings, type AccessSettings } from "./settings";

/**
 * The optional password (Settings › Interface › Access). Off by default: Afflatus is open to whoever reaches its port,
 * as it always was. Set, every API route but a few (access-api.ts) needs a signed-in device, except a request from this
 * computer itself when "From this computer" is on (hostCheck.ts fromThisComputer). What it protects is the network side:
 * the library, the renders, the GPUs and pods, the keys Afflatus holds; not the files on the disk, which are the
 * account's and the disk's to protect.
 *
 * The password is kept as scrypt's hash with a salt of its own; a device signed in holds a random token in a cookie, and
 * the database only its SHA-256 (sessions). Wrong tries are limited per address, escalating, and over every address at
 * once, so that a proxy that hides the addresses cannot be used to try a list; a reset code is limited the same way.
 */

/** scrypt's cost: 32 MiB and some 50-100 ms a check on a desktop CPU. One check at a time (see `turn`), never several at once. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const MAXMEM = 96 * 1024 * 1024;
export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;

/** A browser session (not remembered) ends after this long without a request. */
export const IDLE_MS = 12 * 3600_000;
/** How often a session's last seen is written: a request a second must not mean a write a second. */
const TOUCH_MS = 60_000;
/** How long a session read from the database is taken as it is: a sign-out here forgets it at once, a reset from the command line within this. */
const CACHE_MS = 5_000;

/** A reset code: valid this long, at most this many wrong entries, at most one sent a minute and so many an hour. */
const CODE_MS = 10 * 60_000;
const CODE_TRIES = 5;
const SEND_GAP_MS = 60_000;
const SENDS_PER_HOUR = 6;
/**
 * Wrong codes over a day, every code and address together, before codes are paused for the rest of the day: 6 digits
 * with 5 tries a code are a 1 in 200 000 chance a code, and without a ceiling a patient script would get there in months.
 */
const WRONG_CODES_PER_DAY = 20;

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The password as stored: "scrypt$N$r$p$salt$hash", the salt and the hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** A stored hash to check against when there is none, so that a check takes the same time either way. */
let dummy: Promise<string> | null = null;

/** Whether `password` is the one stored. Always runs scrypt, a stored value that does not read included, and compares in constant time. */
export async function checkPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  const [kind, n, r, p, salt, hash] = parts;
  const N = Number(n), R = Number(r), P = Number(p);
  const good = parts.length === 6 && kind === "scrypt" && Number.isInteger(Math.log2(N)) && N >= 2 ** 14 && N <= 2 ** 17 && R >= 1 && R <= 16 && P >= 1 && P <= 4;
  if (!good) {
    dummy ??= hashPassword(randomBytes(12).toString("hex"));
    await checkPassword(password, await dummy);
    return false;
  }
  const want = Buffer.from(hash!, "base64");
  const got = await scrypt(password.normalize("NFC"), Buffer.from(salt!, "base64"), want.length || SCRYPT.keylen, { N, r: R, p: P, maxmem: MAXMEM });
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A new password's length, said as the page shows it. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `A password is ${PASSWORD_MIN} characters at least.`;
  if (password.length > PASSWORD_MAX) return `A password is ${PASSWORD_MAX} characters at most.`;
  return null;
}

/** The limits of the wrong tries: per address, waits that grow (1, 5, then 15 min), forgotten after a day without one; and all addresses at once. */
export const TRY_LIMITS = { perAddress: 5, waitsMs: [60_000, 300_000, 900_000], quietMs: 24 * 3600_000, globalPerMinute: 30, globalWaitMs: 60_000 };

/**
 * Wrong tries, counted per client address and over every address. Five wrong from one address: it waits a minute, then
 * five more and five minutes, then fifteen each time, until a right one or a day without a wrong one. Thirty wrong in a
 * minute from anywhere: everyone waits a minute (a proxy in front shows every request from its own address, and a list
 * tried through it from many places would otherwise never be stopped).
 */
export class Tries {
  private readonly by = new Map<string, { count: number; level: number; until: number; last: number }>();
  private recent: number[] = [];
  private everyoneUntil = 0;

  constructor(private readonly now: () => number = Date.now, private readonly limits = TRY_LIMITS) {}

  /** How long this address must wait before its next try, in ms; 0 when it may try now. */
  waitMs(address: string): number {
    const t = this.now();
    const one = this.by.get(address);
    return Math.max(one && one.until > t ? one.until - t : 0, this.everyoneUntil > t ? this.everyoneUntil - t : 0);
  }

  /** A wrong try: how many are left before a wait, and the wait it now has (0: none yet). */
  failed(address: string): { left: number; waitMs: number } {
    const t = this.now();
    const { perAddress, waitsMs, quietMs, globalPerMinute, globalWaitMs } = this.limits;
    let one = this.by.get(address);
    if (!one || t - one.last > quietMs) one = { count: 0, level: 0, until: 0, last: t };
    one.last = t;
    one.count++;
    if (one.count >= perAddress) {
      one.until = t + waitsMs[Math.min(one.level, waitsMs.length - 1)]!;
      one.level++;
      one.count = 0;
    }
    this.by.set(address, one);
    this.recent = this.recent.filter((at) => t - at < 60_000);
    this.recent.push(t);
    if (this.recent.length >= globalPerMinute) {
      this.everyoneUntil = t + globalWaitMs;
      this.recent = [];
    }
    // the addresses of a day ago are let go, so that a scan from many addresses does not grow this for good
    if (this.by.size > 5000) for (const [a, o] of this.by) if (t - o.last > quietMs && o.until <= t) this.by.delete(a);
    const waitMs = this.waitMs(address);
    return { left: waitMs ? 0 : perAddress - one.count, waitMs };
  }

  /** A right one: this address starts afresh. */
  succeeded(address: string): void {
    this.by.delete(address);
  }
}

/** "Chrome on Windows", "Safari on iPhone": a device as its browser says it is (its User-Agent), for the list and the notice. */
export function deviceName(ua: string): string {
  const browser = /\bEdg(?:e|A|iOS)?\//.test(ua) ? "Edge" : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera" : /\bFirefox\/|\bFxiOS\//.test(ua) ? "Firefox"
    : /\bChrome\/|\bCriOS\//.test(ua) ? "Chrome" : /\bSafari\//.test(ua) ? "Safari" : /^curl\//i.test(ua) ? "curl" : "A browser";
  const os = /\biPhone\b/.test(ua) ? "iPhone" : /\biPad\b/.test(ua) ? "iPad" : /\bAndroid\b/.test(ua) ? "Android" : /\bWindows\b/.test(ua) ? "Windows"
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS" : /\bCrOS\b/.test(ua) ? "ChromeOS" : /\bLinux\b/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** A session's row, as read. */
interface SessionRow { id: string; device_id: string; created_at: string; last_seen_at: string; expires_at: string; ip: string; user_agent: string; remember: number }

/** Who a request is, for the lock: a session's id when it has a good one; `bypass` when it is this computer's and that needs no password. */
export interface Who { session: string | null; bypass: boolean }

/** A device signed in, as Settings › Access lists it. */
export interface DeviceView { id: string; name: string; firstSeen: string; ip: string; lastSeen: string; remember: boolean; here: boolean }

/** What a sign-in hands back: the cookie's token, the device's own cookie, and how long the cookie lives (null: the browser's session). */
export interface Granted { token: string; device: string; maxAgeS: number | null }

/** A refusal with the wait, said to the page: 429 and the seconds left. */
function waitError(ms: number, what = "Too many wrong tries"): Error {
  const err = httpError(`${what}: wait ${Math.ceil(ms / 1000)} s.`, 429) as Error & { wait?: number };
  err.wait = Math.ceil(ms / 1000);
  return err;
}

/** A wrong password or code: 403, with the tries left before a wait (and the wait, once there is one). */
function wrongError(message: string, left: number, waitMs: number): Error {
  const err = httpError(message, 403) as Error & { left?: number; wait?: number };
  err.left = left;
  if (waitMs) err.wait = Math.ceil(waitMs / 1000);
  return err;
}

export interface AccessOptions {
  /** The log file the reset codes and the sign-ins are written to as well as the console (data/logs/afflatus.log); none in the tests. */
  logFile?: string;
  now?: () => number;
  log?: Pick<Console, "log" | "warn">;
}

/**
 * The password, the sessions, the limits and the reset codes. Emits "changed" when a session ended or the lock changed,
 * for the event stream to end what is no longer allowed (events.ts).
 */
export class Access extends EventEmitter {
  readonly passwordTries: Tries;
  readonly codeTries: Tries;
  private readonly now: () => number;
  private readonly log: Pick<Console, "log" | "warn">;
  /** The reset code waiting, as an HMAC under a key of this run's: it never outlives the process, nor is it in the database. */
  private code: { mac: Buffer; expires: number; wrong: number } | null = null;
  private readonly codeKey = randomBytes(32);
  private sends: number[] = [];
  private wrongCodes: number[] = [];
  private readonly cache = new Map<string, { row: SessionRow | null; at: number }>();
  /** One scrypt check at a time: a burst of sign-ins would otherwise take 32 MiB each at once. */
  private turn: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private logFailed = false;

  constructor(private readonly db: Db, private readonly notify: Notify | null, private readonly opts: AccessOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console;
    this.passwordTries = new Tries(this.now);
    this.codeTries = new Tries(this.now);
  }

  async settings(): Promise<AccessSettings> {
    return (await readSettings(this.db)).access;
  }

  /** A line of the record: who signed in, a wrong try (its address, never what was typed), a code sent or used, a sign-out everywhere. */
  async audit(line: string, warn = false): Promise<void> {
    this.log[warn ? "warn" : "log"](`[access] ${line}`);
    await this.toLogFile(`[access] ${line}`);
  }

  private async toLogFile(text: string): Promise<void> {
    const file = this.opts.logFile;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${new Date(this.now()).toISOString()} ${text.replace(/\r?\n/g, "\n    ")}\n`);
    } catch (err) {
      if (!this.logFailed) this.log.warn(`[access] the log file ${file} cannot be written: ${(err as Error).message}`);
      this.logFailed = true;
    }
  }

  /** scrypt, one check at a time; too many waiting is a short wait for the page, not a pile of 32 MiB checks. */
  private async check(password: string, stored: string | null): Promise<boolean> {
    if (this.waiting >= 16) throw waitError(5000, "Afflatus is busy checking passwords");
    this.waiting++;
    const mine = this.turn.then(() => checkPassword(password, stored));
    this.turn = mine.catch(() => {});
    try {
      return await mine;
    } finally {
      this.waiting--;
    }
  }

  /**
   * The current password checked for a change or a sign-in, under the limits: a wait throws 429, a wrong one 403 with the
   * tries left. Nothing is said of a wrong one beyond that, and a right one takes as long.
   */
  private async verify(password: string, ip: string, stored: string | null, wrongSaid: string): Promise<void> {
    const wait = this.passwordTries.waitMs(ip);
    if (wait) throw waitError(wait);
    const ok = await this.check(password, stored);
    // another try may have started the wait while this one was checked: it holds for this one too
    const after = this.passwordTries.waitMs(ip);
    if (after && !ok) throw waitError(after);
    if (!ok) {
      const { left, waitMs } = this.passwordTries.failed(ip);
      await this.audit(`wrong password from ${ip}`, true);
      throw wrongError(wrongSaid, left, waitMs);
    }
    this.passwordTries.succeeded(ip);
  }

  // ---------------------------------------------------------------- sessions

  /** The session a cookie's token names, when it is good: not ended, not expired. Its last seen written at most once a minute. */
  async sessionOf(token: string | undefined, ip: string): Promise<SessionRow | null> {
    if (!token || token.length > 200) return null;
    const id = sha256(token);
    const t = this.now();
    let hit = this.cache.get(id);
    if (!hit || t - hit.at > CACHE_MS) {
      const row = (await this.db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
      hit = { row, at: t };
      this.cache.set(id, hit);
      if (this.cache.size > 2000) for (const [k, v] of this.cache) if (t - v.at > CACHE_MS) this.cache.delete(k);
    }
    const row = hit.row;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= t) {
      await this.drop([row.id]);
      return null;
    }
    if (t - Date.parse(row.last_seen_at) >= TOUCH_MS) {
      const seen = new Date(t).toISOString();
      // a browser session's end moves with its use; a remembered one ends when it was given to
      const expires = row.remember ? row.expires_at : new Date(t + IDLE_MS).toISOString();
      await this.db.updateTable("sessions").set({ last_seen_at: seen, ip, expires_at: expires }).where("id", "=", row.id).execute();
      hit.row = { ...row, last_seen_at: seen, ip, expires_at: expires };
    }
    return hit.row;
  }

  /** Whether a stream opened by `who` may go on: the lock may have come since, or its session ended. */
  async allows(who: Who, local: boolean): Promise<boolean> {
    const a = await this.settings();
    if (!a.password) return true;
    if (local && a.localNoPassword) return true;
    if (!who.session) return false;
    this.cache.delete(who.session);
    const row = await this.db.selectFrom("sessions").select(["id", "expires_at"]).where("id", "=", who.session).executeTakeFirst();
    return Boolean(row && Date.parse(row.expires_at) > this.now());
  }

  /** A new session for this device, its device known from now on: told of when it was never seen (newDevice). */
  private async grant(opts: { ip: string; ua: string; device: string | undefined; remember: boolean; tell: boolean }): Promise<Granted> {
    const t = this.now();
    const { stayDays } = await this.settings();
    const device = opts.device && /^[\w-]{20,100}$/.test(opts.device) ? opts.device : randomBytes(24).toString("base64url");
    const deviceId = sha256(device);
    const name = deviceName(opts.ua);
    const known = await this.db.selectFrom("devices").select("id").where("id", "=", deviceId).executeTakeFirst();
    if (!known) {
      await this.db.insertInto("devices").values({ id: deviceId, first_seen_at: new Date(t).toISOString(), name }).onConflict((oc) => oc.column("id").doNothing()).execute();
      if (opts.tell) this.notify?.say("newDevice", { title: "New device signed in", body: `${name} from ${opts.ip}. Not you? Settings › Interface › Access: Sign out everywhere, and change the password.`, key: deviceId });
    }
    const token = randomBytes(32).toString("base64url");
    const lifeMs = opts.remember ? stayDays * 86_400_000 : IDLE_MS;
    await this.db.insertInto("sessions").values({
      id: sha256(token), device_id: deviceId, created_at: new Date(t).toISOString(), last_seen_at: new Date(t).toISOString(),
      expires_at: new Date(t + lifeMs).toISOString(), ip: opts.ip, user_agent: opts.ua.slice(0, 400), remember: opts.remember ? 1 : 0,
    }).execute();
    // the sessions that ended on their own are let go at each sign-in
    await this.db.deleteFrom("sessions").where("expires_at", "<=", new Date(t).toISOString()).execute();
    return { token, device, maxAgeS: opts.remember ? stayDays * 86_400 : null };
  }

  /** Sessions ended: forgotten here at once, and the streams they hold are told (events.ts). */
  private async drop(ids: string[] | "all", keep?: string | null): Promise<void> {
    let q = this.db.deleteFrom("sessions");
    if (ids !== "all") q = q.where("id", "in", ids.length ? ids : [""]);
    if (keep) q = q.where("id", "!=", keep);
    await q.execute();
    this.cache.clear();
    this.emit("changed");
  }

  /** Sign in with the password: a session for this device, or a refusal with the tries left or the wait. */
  async signIn(opts: { password: string; remember: boolean; ip: string; ua: string; device: string | undefined }): Promise<Granted> {
    const a = await this.settings();
    if (!a.password) throw httpError("This Afflatus has no password: nothing to sign in to.", 409);
    await this.verify(opts.password, opts.ip, a.password.hash, "Wrong password");
    const granted = await this.grant({ ...opts, tell: true });
    await this.audit(`signed in: ${deviceName(opts.ua)} from ${opts.ip}${opts.remember ? ", remembered" : ""}`);
    return granted;
  }

  /** Sign out this device. */
  async signOut(session: string | null): Promise<void> {
    if (session) await this.drop([session]);
  }

  /** The devices signed in now, the latest seen first; `here` marks the one asking. */
  async devices(here: string | null): Promise<DeviceView[]> {
    const t = new Date(this.now()).toISOString();
    const rows = await this.db.selectFrom("sessions").leftJoin("devices", "devices.id", "sessions.device_id")
      .select(["sessions.id", "sessions.ip", "sessions.user_agent", "sessions.last_seen_at", "sessions.created_at", "sessions.remember", "devices.first_seen_at"])
      .where("sessions.expires_at", ">", t).orderBy("sessions.last_seen_at", "desc").execute();
    return rows.map((r) => ({ id: r.id, name: deviceName(r.user_agent), firstSeen: r.first_seen_at ?? r.created_at, ip: r.ip, lastSeen: r.last_seen_at, remember: r.remember === 1, here: r.id === here }));
  }

  /** Sign out one device of the list. */
  async signOutDevice(id: string, by: string): Promise<void> {
    const row = await this.db.selectFrom("sessions").select(["id", "user_agent", "ip"]).where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError("That device is not signed in.", 404);
    await this.drop([id]);
    await this.audit(`signed out ${deviceName(row.user_agent)} (${row.ip}), from ${by}`);
  }

  /** Sign out every device, this one too unless `keep` names its session. */
  async signOutEverywhere(keep: string | null, by: string): Promise<void> {
    await this.drop("all", keep);
    await this.audit(`signed out everywhere${keep ? " but the device asking" : ""}, from ${by}`);
  }

  // ---------------------------------------------------------------- the password

  /** The password written, or taken off (null). */
  private async store(hash: string | null): Promise<void> {
    await updateSettings(this.db, (s) => ({ access: { ...s.access, password: hash ? { hash, setAt: new Date(this.now()).toISOString() } : null } }));
    this.emit("changed");
  }

  /** Telegram told that the password changed (when it is set up): a change the owner did not make is seen at once. */
  private async tellChanged(title: string, body: string): Promise<void> {
    if (!this.notify || !(await this.notify.telegramSet())) return;
    await this.notify.toTelegram({ title, body }).catch((err: Error) => this.log.warn(`[access] Telegram not told: ${err.message}`));
  }

  /**
   * Set a password, or change it: the current one is needed when there is one. The device asking stays signed in (a session
   * is made for it when it needs one: not from this computer, or this computer needs a password too); `signOutOthers` ends
   * every other session.
   */
  async setPassword(opts: { current: string; password: string; signOutOthers: boolean; ip: string; ua: string; device: string | undefined; session: string | null; bypass: boolean }): Promise<Granted | null> {
    const problem = passwordProblem(opts.password);
    if (problem) throw httpError(problem, 400);
    const a = await this.settings();
    if (a.password) await this.verify(opts.current, opts.ip, a.password.hash, "Wrong current password");
    await this.store(await hashPassword(opts.password));
    if (a.password && opts.signOutOthers) await this.drop("all", opts.session);
    const granted = opts.session || opts.bypass ? null : await this.grant({ ip: opts.ip, ua: opts.ua, device: opts.device, remember: true, tell: false });
    await this.audit(`password ${a.password ? "changed" : "set"} from ${deviceName(opts.ua)} (${opts.ip})${a.password && opts.signOutOthers ? ", every other device signed out" : ""}`);
    if (a.password) await this.tellChanged("Afflatus: password changed", `From ${deviceName(opts.ua)} (${opts.ip}).${opts.signOutOthers ? " Every other device was signed out." : ""}`);
    return granted;
  }

  /** Turn the password off: the current one is needed; every session ends, none is needed any more. */
  async passwordOff(opts: { current: string; ip: string; ua: string }): Promise<void> {
    const a = await this.settings();
    if (!a.password) return;
    await this.verify(opts.current, opts.ip, a.password.hash, "Wrong current password");
    await this.store(null);
    await this.drop("all");
    await this.audit(`password turned off from ${deviceName(opts.ua)} (${opts.ip})`, true);
    await this.tellChanged("Afflatus: password turned off", `From ${deviceName(opts.ua)} (${opts.ip}). Anyone who reaches Afflatus can use it now.`);
  }

  // ---------------------------------------------------------------- reset codes

  /** Where a code may go now: this computer always, Telegram when it is set up and the Access setting allows it. */
  async resetWays(): Promise<{ telegram: boolean; computer: true }> {
    const a = await this.settings();
    return { telegram: a.resetTelegram && Boolean(await this.notify?.telegramSet()), computer: true };
  }

  /** Codes are paused for the rest of the day once too many wrong ones came in it: the wait, or 0. */
  private codesPausedMs(): number {
    const t = this.now();
    this.wrongCodes = this.wrongCodes.filter((at) => t - at < 86_400_000);
    return this.wrongCodes.length >= WRONG_CODES_PER_DAY ? this.wrongCodes[0]! + 86_400_000 - t : 0;
  }

  private mac(code: string): Buffer {
    return createHmac("sha256", this.codeKey).update(code).digest();
  }

  /** The seconds before another code may be sent (0: now). */
  sendAgainS(): number {
    const t = this.now();
    const last = this.sends.at(-1);
    return last !== undefined && t - last < SEND_GAP_MS ? Math.ceil((SEND_GAP_MS - (t - last)) / 1000) : 0;
  }

  /**
   * A new reset code, valid 10 minutes and once, sent to Telegram or written to this computer's console and log file. It
   * replaces the one before. One a minute, six an hour.
   */
  async forgot(via: "telegram" | "computer", ip: string): Promise<{ via: "telegram" | "computer"; again: number }> {
    const a = await this.settings();
    if (!a.password) throw httpError("This Afflatus has no password: nothing to reset.", 409);
    if (via === "telegram" && !(await this.resetWays()).telegram) throw httpError("Reset codes do not go to Telegram here: use This computer.", 409);
    const paused = this.codesPausedMs();
    if (paused) throw waitError(paused, "Too many wrong codes today: codes are paused (the command line still resets it)");
    const wait = this.codeTries.waitMs(ip);
    if (wait) throw waitError(wait);
    const t = this.now();
    const again = this.sendAgainS();
    if (again) throw waitError(again * 1000, "A code was just sent");
    this.sends = this.sends.filter((at) => t - at < 3600_000);
    if (this.sends.length >= SENDS_PER_HOUR) throw waitError(this.sends[0]! + 3600_000 - t, `${SENDS_PER_HOUR} codes this hour already`);
    this.sends.push(t);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.code = { mac: this.mac(code), expires: t + CODE_MS, wrong: 0 };
    if (via === "telegram") {
      try {
        await this.notify!.toTelegram({ title: "Afflatus password reset", body: `Code: ${code}\nValid 10 minutes, once. Asked from ${ip}. Not you? Ignore it: the password stays as it is.` });
      } catch (err) {
        this.code = null;
        throw err;
      }
    } else {
      const banner = [
        "",
        "=".repeat(60),
        `  AFFLATUS PASSWORD RESET CODE: ${code}`,
        `  Valid 10 minutes, once. Asked from ${ip}.`,
        "  Not you? Ignore it: the password stays as it is.",
        "=".repeat(60),
        "",
      ].join("\n");
      this.log.warn(banner);
      await this.toLogFile(`[access] password reset code: ${code} (valid 10 minutes, once; asked from ${ip})`);
    }
    await this.audit(`reset code sent to ${via === "telegram" ? "Telegram" : "this computer"}, asked from ${ip}`);
    return { via, again: Math.ceil(SEND_GAP_MS / 1000) };
  }

  /**
   * A new password through a reset code: the code checked (5 wrong ones burn it), the password set, this device signed in;
   * `signOutOthers` ends every other session. Telegram is told.
   */
  async reset(opts: { code: string; password: string; signOutOthers: boolean; ip: string; ua: string; device: string | undefined; session: string | null }): Promise<Granted> {
    const a = await this.settings();
    if (!a.password) throw httpError("This Afflatus has no password: nothing to reset.", 409);
    const paused = this.codesPausedMs();
    if (paused) throw waitError(paused, "Too many wrong codes today: codes are paused (the command line still resets it)");
    const wait = this.codeTries.waitMs(opts.ip);
    if (wait) throw waitError(wait);
    // the new password is looked at first: a typo there does not spend a try of the code
    const problem = passwordProblem(opts.password);
    if (problem) throw httpError(problem, 400);
    const t = this.now();
    if (this.code && this.code.expires <= t) this.code = null;
    const given = /^\d{6}$/.test(opts.code) ? this.mac(opts.code) : null;
    const right = Boolean(this.code && given && timingSafeEqual(this.code.mac, given));
    if (!right) {
      const { waitMs } = this.codeTries.failed(opts.ip);
      this.wrongCodes.push(t);
      if (!this.code) throw wrongError("No code is waiting, or it expired: ask for a new one.", 0, waitMs);
      this.code.wrong++;
      const left = CODE_TRIES - this.code.wrong;
      await this.audit(`wrong reset code from ${opts.ip}`, true);
      if (left <= 0) {
        this.code = null;
        throw wrongError("Wrong code: it is used up. Ask for a new one.", 0, waitMs);
      }
      throw wrongError("Wrong code", left, waitMs);
    }
    this.code = null;
    this.codeTries.succeeded(opts.ip);
    this.passwordTries.succeeded(opts.ip);
    await this.store(await hashPassword(opts.password));
    if (opts.signOutOthers) await this.drop("all");
    else if (opts.session) await this.drop([opts.session]);
    const granted = await this.grant({ ip: opts.ip, ua: opts.ua, device: opts.device, remember: true, tell: true });
    await this.audit(`password reset with a code from ${deviceName(opts.ua)} (${opts.ip})${opts.signOutOthers ? ", every other device signed out" : ""}`, true);
    await this.tellChanged("Afflatus: password changed", `Reset with a code, from ${deviceName(opts.ua)} (${opts.ip}).${opts.signOutOthers ? " Every other device was signed out." : ""}`);
    return granted;
  }
}

/**
 * The password and every session removed, without the page: AFFLATUS_RESET_PASSWORD=1 at a start (start.ts), or the
 * `reset-password` command (index.ts) with Afflatus stopped. For an owner who lost the password and every way to a code.
 */
export async function resetAccess(db: Db, log: Pick<Console, "log" | "warn"> = console): Promise<boolean> {
  const had = (await readSettings(db)).access.password !== null;
  if (had) await updateSettings(db, (s) => ({ access: { ...s.access, password: null } }));
  const ended = await db.deleteFrom("sessions").executeTakeFirst();
  const n = Number(ended.numDeletedRows ?? 0);
  log.warn(`[access] ${had ? "THE PASSWORD WAS REMOVED" : "there was no password"}${n ? `; ${plural(n, "device")} signed out` : ""}. Afflatus is open to whoever reaches it: set a new password in Settings › Interface › Access.`);
  return had;
}
