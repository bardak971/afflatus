import type { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelOf, plural } from "@afflatus/core";
import { envSaid } from "./config";
import { toRun, type Db } from "./db";
import { httpError } from "./errors";
import { dollars, machineSaid, took, type Notice } from "./notifyWords";
import type { Registry } from "./registry";
import { discordHookOk, readSettings, type NotifyKind, type NotifySettings } from "./settings";
import type { Storage } from "./storage";
import { makeStill } from "./thumbs";

/**
 * Notices, one way: what the user would want to know while away from the screen (a render failed, the queue ran empty, a
 * rented pod stopped and what it cost), sent to Telegram (a bot of the user's) and Discord (a channel's webhook), and pushed
 * to the open pages ("notice"), which show it as a browser notification where this browser's tick says so.
 *
 * A notice never stands in the way of what it is about: say() returns at once, a send that fails is logged once (the
 * token and the webhook taken out of what is logged) and is never thrown to the caller. Within a minute the same notice
 * (kind and key) goes once, failures within 30 s go as one message, and past 20 messages a minute the rest are dropped,
 * except the notices about money (MONEY_KINDS), which always go.
 */

export type Channel = "telegram" | "discord";

export interface NotifyOptions {
  /** Failures after the first within this window are folded into one message at its end. */
  foldMs: number;
  /** The same kind and key is said at most once in this long. */
  sameMs: number;
  /** At most this many messages a minute go to Telegram and Discord. */
  perMinute: number;
  /** A render that moved by nothing this long is told of as stuck, once. */
  stuckMs: number;
  /** How often the renders under way are looked at for that. */
  stuckEveryMs: number;
  /** How long a send may take. */
  timeoutMs: number;
}

/**
 * The notices about money: a cap reached, a pod stopped, the balance low, a hunt given up. They are said once (rented.ts
 * marks a cap as told before saying it), so one dropped by a minute full of renders done would never reach the owner.
 */
const MONEY_KINDS: ReadonlySet<NotifyKind> = new Set(["capReached", "podStopped", "balanceLow", "huntGaveUp"]);

export const NOTIFY_DEFAULTS: NotifyOptions = { foldMs: 30_000, sameMs: 60_000, perMinute: 20, stuckMs: 20 * 60_000, stuckEveryMs: 60_000, timeoutMs: 10_000 };

/** What the service reads: the database, the files (for a picture), the recipes (a render's model), the queue's renders under way, and what the rented GPUs cost. */
export interface NotifyDeps {
  db: Db;
  storage: Storage;
  registry: Registry;
  events: EventEmitter;
  stillFor(): Array<{ job: string; machine: string; ms: number }>;
  /** What the rented GPUs cost for a batch of renders (rented.ts batchCost): the runs it overlaps from their start, not before `notBefore`. */
  batchCost(from: number, to: number, notBefore: number): Promise<number>;
}

/** Telegram's HTML wants these three escaped, nothing more. */
const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Discord's markdown marks taken as text. */
const plain = (text: string) => text.replace(/([\\*_~`|>])/g, "\\$1");
/** One line of an error: the first, cut short. */
const line = (text: string | null | undefined, max = 200) => {
  const first = (text ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/** An error's words with its cause (fetch says only "fetch failed"), the secrets taken out. */
export function redacted(err: unknown, secrets: string[]): string {
  const e = err as Error & { cause?: { message?: string; code?: string } };
  let text = e?.name === "TimeoutError" ? "no answer in time" : e?.message ?? String(err);
  if (e?.cause?.code || e?.cause?.message) text += ` (${e.cause.code ?? e.cause.message})`;
  for (const secret of secrets) if (secret.length >= 6) text = text.split(secret).join("…");
  return text;
}

/** The secrets a notice's errors could carry: the token, the webhook, and the webhook's own token (its last part). */
const secretsOf = (n: NotifySettings) => [n.telegramToken, n.discordWebhook, n.discordWebhook.split("/").pop() ?? ""].filter(Boolean);

/** Telegram's Bot API: a stand-in's in the tests, none at all where no site on the internet is asked (the demo). */
function telegramBase(): string {
  const stand = envSaid.telegramUrl();
  if (stand) return stand.replace(/\/+$/, "");
  if (envSaid.pretendSites()) throw new Error("not sent: no site on the internet is asked here");
  return "https://api.telegram.org";
}

export class Notify {
  /** The limits and the waits: shorter in the tests. */
  opts: NotifyOptions;
  /** When each kind and key was last said. */
  private readonly said = new Map<string, number>();
  /** When each of the last minute's messages went. */
  private sent: number[] = [];
  /** The minute's overflow was logged. */
  private droppedLogged = false;
  /** Failures folded while their window is open: null when none is. */
  private folding: { names: string[]; timer: NodeJS.Timeout } | null = null;
  /** What each channel last failed with, logged once until it works again. */
  private readonly failing = new Map<Channel, string>();
  /** The renders since the queue last had nothing to do. */
  private batch: { from: number; done: number; failed: string[]; last: string | null } | null = null;
  /** One job's end at a time: the batch is read and written in order. */
  private ending: Promise<void> = Promise.resolve();
  /** The renders told of as stuck. */
  private stuckSaid = new Set<string>();
  private stuckTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** The sends to Telegram and Discord, in order: each starts once the one before ended (sent, failed or timed out). */
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotifyDeps, opts: Partial<NotifyOptions> = {}) {
    this.opts = { ...NOTIFY_DEFAULTS, ...opts };
  }

  /** Hear the queue's jobs end and look at its renders under way, until stop(). */
  watch(): void {
    this.deps.events.on("ended", (id: string, status: string) => {
      this.ending = this.ending.then(() => this.ended(id, status)).catch((err: Error) => console.warn(`[notify] a job's end not told: ${err.message}`));
    });
    this.stuckTimer = setInterval(() => void this.lookStuck().catch((err: Error) => console.warn(`[notify] ${err.message}`)), this.opts.stuckEveryMs);
    this.stuckTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    if (this.folding) clearTimeout(this.folding.timer);
    this.folding = null;
  }

  /** The job ends told of so far, settled: for the tests. */
  settled(): Promise<void> {
    return this.ending;
  }

  /**
   * Tell the user. Returns at once: the page hears it now, Telegram and Discord in the background. The same kind and key
   * within a minute is dropped; a failure while others' window is open waits to go with them.
   */
  say(kind: NotifyKind, notice: Notice): void {
    if (this.stopped) return;
    const now = Date.now();
    const key = `${kind}:${notice.key ?? notice.title}`;
    const last = this.said.get(key);
    if (last !== undefined && now - last < this.opts.sameMs) return;
    this.said.set(key, now);
    if (this.said.size > 500) for (const [k, at] of this.said) if (now - at >= this.opts.sameMs) this.said.delete(k);
    if (kind === "renderFailed") {
      if (this.folding) {
        this.folding.names.push(notice.title.replace(/^Failed: /, ""));
        return;
      }
      this.openFold();
    }
    this.deliver(kind, notice);
  }

  /** The window failures are folded in: at its end, what came meanwhile goes as one message, and another window opens. */
  private openFold(): void {
    const timer = setTimeout(() => {
      const names = this.folding?.names ?? [];
      this.folding = null;
      if (!names.length || this.stopped) return;
      this.openFold();
      const shown = names.slice(0, 10);
      this.deliver("renderFailed", { title: `${plural(names.length, "more render")} failed`, body: `${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}.`, key: "folded" });
    }, this.opts.foldMs);
    timer.unref();
    this.folding = { names: [], timer };
  }

  /**
   * To the open pages at once, and to the channels ticked for its kind in the background, one after another in the order
   * they were said: a render's "Done" with its picture took longer to send than the "Queue empty" after it, which came first.
   */
  private deliver(kind: NotifyKind, notice: Notice): void {
    this.deps.events.emit("notice", { kind, title: notice.title, body: notice.body });
    this.sending = this.sending.then(() => this.toChannels(kind, notice)).catch((err: Error) => console.warn(`[notify] ${err.message}`));
  }

  private async toChannels(kind: NotifyKind, notice: Notice): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    const ticked = n.events[kind];
    const to: Channel[] = [];
    if (ticked.telegram && n.telegramToken && n.telegramChat) to.push("telegram");
    if (ticked.discord && n.discordWebhook) to.push("discord");
    if (!to.length || !this.roomThisMinute(MONEY_KINDS.has(kind))) return;
    const picture = n.picture && notice.asset ? await this.still(notice.asset) : null;
    await Promise.all(to.map((channel) => this.post(channel, n, notice, picture).then(
      () => void this.failing.delete(channel),
      (err) => this.failed(channel, n, err),
    )));
  }

  /** A send that failed: logged once, until that channel works again. */
  private failed(channel: Channel, n: NotifySettings, err: unknown): void {
    const said = redacted(err, secretsOf(n));
    if (this.failing.get(channel) === said) return;
    this.failing.set(channel, said);
    console.warn(`[notify] ${channel} not sent: ${said}`);
  }

  /**
   * One more message this minute, or none: past the limit, the rest are dropped (said once in the log). A notice about
   * money always has room; it still counts towards the minute's messages.
   */
  private roomThisMinute(money = false): boolean {
    const now = Date.now();
    this.sent = this.sent.filter((at) => now - at < 60_000);
    if (!money && this.sent.length >= this.opts.perMinute) {
      if (!this.droppedLogged) console.warn(`[notify] more than ${this.opts.perMinute} notices in a minute: the rest of this minute's are not sent`);
      this.droppedLogged = true;
      return false;
    }
    this.droppedLogged = false;
    this.sent.push(now);
    return true;
  }

  /** A JPEG of what a notice is about: a picture itself, or a video's or a frame's thumbnail; null for a sound or what cannot be read. */
  private async still(assetId: string): Promise<Uint8Array | null> {
    try {
      const a = await this.deps.db.selectFrom("assets").select(["kind", "file_key", "thumb_key"]).where("id", "=", assetId).executeTakeFirst();
      if (!a || a.kind === "audio") return null;
      const key = a.kind === "image" ? a.file_key : a.thumb_key;
      return key ? await makeStill(await this.deps.storage.get(key)) : null;
    } catch {
      return null;
    }
  }

  /** Send one notice to one channel, now; throws what went wrong (its words may hold a secret: redact before saying them). */
  private async post(channel: Channel, n: NotifySettings, notice: Notice, picture: Uint8Array | null): Promise<void> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    if (channel === "telegram") {
      const method = picture ? "sendPhoto" : "sendMessage";
      // a photo's caption is 1024 characters at most, a message 4096: the body is cut before it is escaped, never inside a tag
      const text = `<b>${html(notice.title.slice(0, 200))}</b>\n${html(notice.body.slice(0, picture ? 800 : 3800))}`;
      let body: FormData | string;
      if (picture) {
        body = new FormData();
        body.set("chat_id", n.telegramChat);
        body.set("caption", text);
        body.set("parse_mode", "HTML");
        body.set("photo", new Blob([picture as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), "afflatus.jpg");
      } else body = JSON.stringify({ chat_id: n.telegramChat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      const res = await fetch(`${telegramBase()}/bot${n.telegramToken}/${method}`, { method: "POST", body, headers: picture ? {} : { "Content-Type": "application/json" }, signal });
      const said = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
      if (!res.ok || said?.ok === false) throw new Error(`Telegram refused it: ${said?.description ?? `HTTP ${res.status}`}`);
      return;
    }
    if (!discordHookOk(n.discordWebhook)) throw new Error("the saved webhook is not a Discord webhook");
    if (envSaid.pretendSites() && !envSaid.discordUrl()) throw new Error("not sent: no site on the internet is asked here");
    // nobody is pinged by a notice, whatever its words hold (an @everyone in a render's name)
    const payload = { content: `**${plain(notice.title.slice(0, 200))}**\n${plain(notice.body.slice(0, 1700))}`, allowed_mentions: { parse: [] } };
    let body: FormData | string;
    if (picture) {
      body = new FormData();
      body.set("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: "afflatus.jpg" }] }));
      body.set("files[0]", new Blob([picture as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), "afflatus.jpg");
    } else body = JSON.stringify(payload);
    const res = await fetch(n.discordWebhook, { method: "POST", body, headers: picture ? {} : { "Content-Type": "application/json" }, signal });
    if (!res.ok) {
      const said = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`Discord refused it: ${said?.message ?? `HTTP ${res.status}`}`);
    }
    await res.body?.cancel().catch(() => {});
  }

  /**
   * A picture or a video of the library sent to one channel, as it is (the file itself, not a thumbnail), with its name: the
   * library's Send to Telegram / Send to Discord. Past every limit of the notices (asked for by hand). What each service takes:
   * Telegram's bots upload 10 MB a photo and 50 MB a video (a larger picture goes as a file, kept whole); a Discord webhook
   * 10 MB a file. Throws the reason, secrets taken out.
   */
  async share(channel: Channel, assetId: string): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    if (channel === "telegram" && !(n.telegramToken && n.telegramChat)) throw httpError("Telegram is not set up: Settings › Notifications.", 409);
    if (channel === "discord" && !n.discordWebhook) throw httpError("Discord is not set up: Settings › Notifications.", 409);
    const a = await this.deps.db.selectFrom("assets").select(["kind", "file_key", "mime", "name", "bytes"]).where("id", "=", assetId).where("deleted_at", "is", null).executeTakeFirst();
    if (!a || (a.kind !== "image" && a.kind !== "video")) throw httpError("Only a picture or a video of the library can be sent.", 404);
    const mb = (a.bytes ?? 0) / 1024 / 1024;
    const most = channel === "discord" ? 10 : 50;
    if (mb > most) throw httpError(`It is ${mb.toFixed(0)} MB: ${channel === "discord" ? "a Discord webhook" : "a Telegram bot"} takes ${most} MB at most. Export a web copy (the timeline's Export, For the web) and send that.`, 413);
    const ext = (a.mime.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace("quicktime", "mov");
    const file = `${(a.name || "afflatus").replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "afflatus"}.${ext}`;
    const blob = new Blob([(await this.deps.storage.get(a.file_key)) as Uint8Array<ArrayBuffer>], { type: a.mime });
    const signal = AbortSignal.timeout(Math.max(this.opts.timeoutMs, 120_000));
    try {
      if (channel === "telegram") {
        // a photo over 10 MB is refused by sendPhoto: sent as a file, whole
        const method = a.kind === "video" ? "sendVideo" : mb > 10 ? "sendDocument" : "sendPhoto";
        const field = method === "sendVideo" ? "video" : method === "sendDocument" ? "document" : "photo";
        const body = new FormData();
        body.set("chat_id", n.telegramChat);
        if (a.name) body.set("caption", a.name.slice(0, 1000));
        if (method === "sendVideo") body.set("supports_streaming", "true");
        body.set(field, blob, file);
        const res = await fetch(`${telegramBase()}/bot${n.telegramToken}/${method}`, { method: "POST", body, signal });
        const said = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
        if (!res.ok || said?.ok === false) throw new Error(`Telegram refused it: ${said?.description ?? `HTTP ${res.status}`}`);
        return;
      }
      if (!discordHookOk(n.discordWebhook)) throw new Error("the saved webhook is not a Discord webhook");
      if (envSaid.pretendSites() && !envSaid.discordUrl()) throw new Error("not sent: no site on the internet is asked here");
      const body = new FormData();
      body.set("payload_json", JSON.stringify({ content: a.name ? plain(a.name.slice(0, 1800)) : "", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: file }] }));
      body.set("files[0]", blob, file);
      const res = await fetch(n.discordWebhook, { method: "POST", body, signal });
      if (!res.ok) {
        const said = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(`Discord refused it: ${said?.message ?? `HTTP ${res.status}`}`);
      }
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      throw httpError(redacted(err, secretsOf(n)), 502);
    }
  }

  /** "Afflatus: test" to one channel, now, past every limit: what Send a test answers. Throws the reason, secrets taken out. */
  async test(channel: Channel): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    if (channel === "telegram" && !(n.telegramToken && n.telegramChat)) throw httpError("Save a bot token and a chat id first.", 409);
    if (channel === "discord" && !n.discordWebhook) throw httpError("Save a webhook first.", 409);
    try {
      await this.post(channel, n, { title: "Afflatus: test", body: "Notices will come here." }, null);
      this.failing.delete(channel);
    } catch (err) {
      throw httpError(redacted(err, secretsOf(n)), 502);
    }
  }

  /** Whether Telegram is set up: a bot token and a chat to write to. */
  async telegramSet(): Promise<boolean> {
    const n = (await readSettings(this.deps.db)).notify;
    return Boolean(n.telegramToken && n.telegramChat);
  }

  /**
   * A message of the password's (a reset code, "Password changed") to Telegram, now, whatever the kinds' ticks and past
   * the minute's limit: the owner asked for it, and access.ts limits how often. Throws the reason, secrets taken out.
   */
  async toTelegram(notice: Notice): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    if (!(n.telegramToken && n.telegramChat)) throw httpError("Telegram is not set up: Settings › Interface › Notifications.", 409);
    try {
      await this.post("telegram", n, notice, null);
    } catch (err) {
      throw httpError(redacted(err, secretsOf(n)), 502);
    }
  }

  /** A message to a Discord webhook given here, not the one saved: the webhook before a change is told of it (access.ts discordChanged). */
  async toDiscordAt(discordWebhook: string, notice: Notice): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    const at = { ...n, discordWebhook };
    try {
      await this.post("discord", at, notice, null);
    } catch (err) {
      throw httpError(redacted(err, secretsOf(at)), 502);
    }
  }

  /** A message to a bot and chat given here, not the ones saved: the chat before a change is told of it (access.ts telegramChanged). */
  async toTelegramAt(to: { telegramToken: string; telegramChat: string }, notice: Notice): Promise<void> {
    const n = (await readSettings(this.deps.db)).notify;
    const at = { ...n, telegramToken: to.telegramToken, telegramChat: to.telegramChat };
    try {
      await this.post("telegram", at, notice, null);
    } catch (err) {
      throw httpError(redacted(err, secretsOf(at)), 502);
    }
  }

  /** The chats that wrote to the bot lately (getUpdates, read once): the user sends it anything first, then picks theirs. */
  async telegramChats(): Promise<Array<{ id: string; name: string; type: string }>> {
    const n = (await readSettings(this.deps.db)).notify;
    if (!n.telegramToken) throw httpError("Save the bot token first.", 409);
    try {
      const res = await fetch(`${telegramBase()}/bot${n.telegramToken}/getUpdates?limit=50&timeout=0`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      const said = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: Array<Record<string, { chat?: { id?: number | string; type?: string; title?: string; username?: string; first_name?: string; last_name?: string } } | undefined>> } | null;
      if (!res.ok || !said?.ok) throw new Error(`Telegram refused it: ${said?.description ?? `HTTP ${res.status}`}`);
      const chats = new Map<string, { id: string; name: string; type: string }>();
      for (const update of said.result ?? []) {
        for (const part of Object.values(update)) {
          const c = part && typeof part === "object" ? part.chat : undefined;
          if (c?.id === undefined) continue;
          const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : String(c.id));
          chats.set(String(c.id), { id: String(c.id), name, type: c.type ?? "" });
        }
      }
      return [...chats.values()];
    } catch (err) {
      throw httpError(redacted(err, secretsOf(n)), 502);
    }
  }

  // ---------------------------------------------------------------- what is told, from the queue

  /** A job ended: its render told of (done, failed), and the queue's batch when nothing is left to do. */
  private async ended(id: string, status: string): Promise<void> {
    const { db } = this.deps;
    const row = await db.selectFrom("jobs").select(["label", "recipe_id", "inputs", "warm", "error", "machine_id", "generation_id", "created_at", "started_at", "finished_at"]).where("id", "=", id).executeTakeFirst();
    if (row && !row.warm && (status === "done" || status === "failed")) {
      const name = row.label || row.recipe_id;
      const from = Date.parse(row.started_at ?? row.created_at);
      const to = row.finished_at ? Date.parse(row.finished_at) : Date.now();
      this.batch ??= { from, done: 0, failed: [], last: null };
      this.batch.from = Math.min(this.batch.from, from);
      const settings = await readSettings(db);
      const machine = settings.machines.find((m) => m.id === row.machine_id);
      const where = machine && settings.machines.length > 1 ? machineSaid(machine) : null;
      if (status === "done") {
        const asset = row.generation_id ? (await db.selectFrom("assets").select("id").where("generation_id", "=", row.generation_id).where("origin", "!=", "mask").orderBy("created_at").executeTakeFirst())?.id ?? null : null;
        this.batch.done++;
        this.batch.last = asset ?? this.batch.last;
        const recipe = this.deps.registry.recipe(row.recipe_id);
        let model: string | null = null;
        try {
          model = recipe ? modelOf(recipe.inputs, JSON.parse(row.inputs) as Record<string, unknown>) : null;
        } catch {
          // inputs that do not read say no model
        }
        const facts = [model, where, Number.isFinite(from) && to > from ? took(to - from) : null].filter(Boolean);
        this.say("renderDone", { title: `Done: ${name}`, body: facts.join(" · ") || "Rendered.", asset, key: id });
      } else {
        this.batch.failed.push(name);
        this.say("renderFailed", { title: `Failed: ${name}`, body: `${line(row.error) || "No reason given."}${where ? ` (${where})` : ""}`, key: id });
      }
    }
    await this.emptied();
  }

  /** Nothing running and nothing waiting, after renders: one notice for the batch. */
  private async emptied(): Promise<void> {
    if (!this.batch) return;
    const left = await this.deps.db.selectFrom("jobs").select("id").where(toRun).limit(1).executeTakeFirst();
    if (left) return;
    const b = this.batch;
    this.batch = null;
    const now = Date.now();
    // a pod's boot and files before the batch's first render on it are the batch's (a deploy for it), never what the batch
    // before counted: the runs are taken from their start, not before the last job that ended before this batch began
    const before = await this.deps.db.selectFrom("jobs").select((eb) => eb.fn.max("finished_at").as("at")).where("finished_at", "<", new Date(b.from).toISOString()).executeTakeFirst();
    const notBefore = before?.at ? Date.parse(before.at) : 0;
    const cost = await this.deps.batchCost(b.from, now, Number.isFinite(notBefore) ? notBefore : 0).catch(() => 0);
    const parts = [
      b.done ? `${plural(b.done, "render")} done` : null,
      b.failed.length ? `${b.failed.length} failed (${b.failed.slice(0, 5).join(", ")}${b.failed.length > 5 ? ", …" : ""})` : null,
      `in ${took(now - b.from)}`,
      cost >= 0.005 ? `rented GPUs ${dollars(cost)}` : null,
    ].filter(Boolean);
    this.say("queueEmpty", { title: "Queue empty", body: parts.join(" · "), asset: b.last, key: String(now) });
  }

  /** The renders under way that moved by nothing for long: each told of once. */
  async lookStuck(): Promise<void> {
    const still = this.deps.stillFor();
    this.stuckSaid = new Set([...this.stuckSaid].filter((job) => still.some((s) => s.job === job)));
    const stuck = still.filter((s) => s.ms >= this.opts.stuckMs && !this.stuckSaid.has(s.job));
    if (!stuck.length) return;
    const settings = await readSettings(this.deps.db);
    for (const s of stuck) {
      this.stuckSaid.add(s.job);
      const row = await this.deps.db.selectFrom("jobs").select(["label", "recipe_id"]).where("id", "=", s.job).executeTakeFirst();
      const machine = settings.machines.find((m) => m.id === s.machine);
      const rented = Boolean(machine?.rented);
      // a pod's render silent this long with its GPU read idle was failed already (at 10 min, rented.ts): one told of here
      // is one whose GPU load is not read, waited for until past its forecast
      this.say("renderStuck", {
        title: `Stuck: ${row?.label || row?.recipe_id || "a render"}`,
        body: `No step, node or preview for ${took(s.ms)} on ${machine ? machineSaid(machine) : "its ComfyUI"}. ${rented ? "On a rented GPU it is failed once past its forecast, 10 min over at most." : "It runs on: stop it in the Queue if it hangs."}`,
        key: s.job,
      });
    }
  }
}

const channelBody = z.object({ channel: z.enum(["telegram", "discord"]) });

/** Send a test, and find the chat id (Settings › Interface › Notifications). The settings themselves go through PUT /api/settings. */
export function registerNotify(app: FastifyInstance, notify: Notify): void {
  app.post("/api/notify/test", async (req) => {
    await notify.test(channelBody.parse(req.body).channel);
    return { ok: true };
  });
  app.post("/api/notify/telegram-chat", async () => ({ chats: await notify.telegramChats() }));
  /** A picture or a video of the library sent as it is, by hand (the library's Send to Telegram / Discord). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/share", async (req) => {
    await notify.share(channelBody.parse(req.body).channel, req.params.id);
    return { ok: true };
  });
}
