import { randomBytes } from "node:crypto";
import { plural } from "@afflatus/core";
import { sha256 } from "./access";
import { csvOf, utc } from "./csv";
import { newId, OWNER, type Db, type Tables } from "./db";
import { httpError, notFound } from "./errors";
import { dollars } from "./notifyWords";

/**
 * The personal tokens an MCP client drives Afflatus with (/mcp, mcp.ts), made in Settings › Interface › Access and shown
 * once: the database keeps their SHA-256, as it does a session's (access.ts) and the metrics token's. A token is good on
 * /mcp only, never on the API nor as a page's session. Each has its scopes, its own limits on top of the app's caps (renders
 * an hour, a spend cap a month), an end, its last use, and the list of what its calls did (kept 30 days).
 */

/**
 * What a token may do. `look`: read everything (always on). `make`: forms, renders on the user's own machines, timelines,
 * the library, the Prompt kit. `spend`: rented GPUs (off unless ticked). `manage`: settings, downloads, machines, caps.
 */
export const SCOPES = ["look", "make", "spend", "manage"] as const;
export type Scope = (typeof SCOPES)[number];

/** The scopes as the page and the refusals say them. */
export const SCOPE_WORDS: Record<Scope, string> = { look: "Look", make: "Make", spend: "Spend", manage: "Manage" };

/** The starting sets the new-token line offers. */
export const STARTS = { look: ["look"], make: ["look", "make"], spend: ["look", "make", "spend"], all: [...SCOPES] } as const satisfies Record<string, readonly Scope[]>;

/** How a token starts: 30 renders an hour, $5 a month on rented GPUs. */
export const DEFAULT_RENDERS_PER_HOUR = 30;
export const DEFAULT_SPEND_CAP_CENTS = 500;
/** The ends a token may have, in days (null: never). */
export const ENDS = [null, 30, 90] as const;
export type Ends = (typeof ENDS)[number];
/** What a token's activity is kept for; a revoked token goes with its last line. */
export const ACTIVITY_DAYS = 30;
/** Used this recently, a token's client counts as connected (its dot): /mcp keeps no connection open (stateless, mcp.ts). */
export const LIVE_MS = 5 * 60_000;
/** How often a token's last use is written: a call a second must not mean a write a second (a new address or client is written at once). */
const TOUCH_MS = 60_000;
/** The token's look: "afl_mcp_" and 43 characters, some 256 bits. */
export const TOKEN_PREFIX = "afl_mcp_";
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A name, a client's name: as long as a line shows. */
const NAME_MAX = 60;

type Row = Tables["mcp_tokens"];

/** A token as the server reads it. */
export interface McpToken {
  id: string;
  name: string;
  scopes: Scope[];
  rendersPerHour: number;
  spendCapCents: number;
  /** Its last four characters, shown so that one pasted somewhere can be told from another. */
  tail: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastIp: string | null;
  lastClient: string | null;
}

/** A token as Settings › Access lists it: with its state and its two meters. */
export interface McpTokenView extends McpToken {
  state: "live" | "idle" | "ended" | "revoked";
  /** Its renders sent in the last hour, and what they cost on rented GPUs this month (USD). */
  rendersThisHour: number;
  spentThisMonth: number;
  /** Its jobs waiting or running now. */
  working: number;
}

/** A line of a token's activity. */
export interface McpActivity { id: string; at: string; tool: string; said: string; refused: boolean; why: string | null }

/** What the page may change of a token. */
export interface McpTokenPatch { name?: string; scopes?: Scope[]; rendersPerHour?: number; spendCapCents?: number; endsDays?: Ends }

/** The scopes as kept, in their order, Look always in. */
export function scopesOf(text: string | readonly string[]): Scope[] {
  const asked = new Set(typeof text === "string" ? text.split(",") : text);
  return SCOPES.filter((s) => s === "look" || asked.has(s));
}

/**
 * A call refused by a scope, the never-list or a limit: said to the client as the web says a refusal (a 403 with words to
 * read), and written as refused in the activity.
 */
export const refusal = (message: string): Error => httpError(message, 403);

const viewOf = (r: Row): McpToken => ({
  id: r.id, name: r.name, scopes: scopesOf(r.scopes), rendersPerHour: r.renders_per_hour, spendCapCents: r.spend_cap_cents, tail: r.tail,
  createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, lastIp: r.last_ip, lastClient: r.last_client,
});

/** A name as kept: one line, trimmed, not too long. */
const cleanName = (name: string) => name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NAME_MAX);

export class McpTokens {
  private readonly now: () => number;
  /** When the old activity was last let go: at most once an hour, as a line is written. */
  private prunedAt = 0;
  private seq = 0;

  constructor(private readonly db: Db, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private endOf(days: Ends): string | null {
    return days === null ? null : this.iso(this.now() + days * DAY);
  }

  /** A new token: the token itself (its only showing) and the token as listed. */
  async make(o: { name: string; scopes: readonly Scope[]; endsDays?: Ends; rendersPerHour?: number; spendCapCents?: number }): Promise<{ token: string; view: McpTokenView }> {
    const name = cleanName(o.name);
    if (!name) throw httpError("Name the token: the client it is for (Claude Desktop, laptop…).");
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = newId();
    await this.db.insertInto("mcp_tokens").values({
      id, owner_id: OWNER, hash: sha256(token), tail: token.slice(-4), name, scopes: scopesOf(o.scopes).join(","),
      renders_per_hour: o.rendersPerHour ?? DEFAULT_RENDERS_PER_HOUR, spend_cap_cents: o.spendCapCents ?? DEFAULT_SPEND_CAP_CENTS,
      created_at: this.iso(), expires_at: this.endOf(o.endsDays ?? null), revoked_at: null, last_used_at: null, last_ip: null, last_client: null,
    }).execute();
    return { token, view: (await this.view(id))! };
  }

  /** One token as read, revoked or ended included; null when there is none. */
  async get(id: string): Promise<McpToken | null> {
    const row = await this.db.selectFrom("mcp_tokens").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? viewOf(row) : null;
  }

  private async view(id: string): Promise<McpTokenView | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }

  /** Every token, the newest first, with its state and meters: the ones revoked stay listed while their activity is kept. */
  async list(): Promise<McpTokenView[]> {
    const rows = await this.db.selectFrom("mcp_tokens").selectAll().orderBy("created_at", "desc").execute();
    if (!rows.length) return [];
    const t = this.now();
    const ids = rows.map((r) => r.id);
    const hour = await this.db.selectFrom("jobs").select(["mcp_token_id"]).select((eb) => eb.fn.countAll<number>().as("n"))
      .where("mcp_token_id", "in", ids).where("warm", "=", 0).where("created_at", ">=", this.iso(t - HOUR)).groupBy("mcp_token_id").execute();
    const working = await this.db.selectFrom("jobs").select(["mcp_token_id"]).select((eb) => eb.fn.countAll<number>().as("n"))
      .where("mcp_token_id", "in", ids).where("status", "in", ["queued", "running"]).groupBy("mcp_token_id").execute();
    const spent = await this.spentThisMonthOf(ids);
    const count = (list: Array<{ mcp_token_id: string | null | undefined; n: number | string }>, id: string) => Number(list.find((x) => x.mcp_token_id === id)?.n ?? 0);
    return rows.map((r) => {
      const v = viewOf(r);
      const state = v.revokedAt ? "revoked" : v.expiresAt && Date.parse(v.expiresAt) <= t ? "ended" : v.lastUsedAt && t - Date.parse(v.lastUsedAt) < LIVE_MS ? "live" : "idle";
      return { ...v, state, rendersThisHour: count(hour, r.id), spentThisMonth: spent.get(r.id) ?? 0, working: count(working, r.id) };
    });
  }

  /** A token's name, scopes, limits or end changed (the page asked for the password first when it had to, mcp-api.ts). */
  async change(id: string, patch: McpTokenPatch): Promise<McpTokenView> {
    const was = await this.get(id);
    if (!was || was.revokedAt) throw notFound("That token");
    const name = patch.name === undefined ? undefined : cleanName(patch.name);
    if (name === "") throw httpError("A token needs a name.");
    await this.db.updateTable("mcp_tokens").set({
      ...(name !== undefined ? { name } : {}),
      ...(patch.scopes ? { scopes: scopesOf(patch.scopes).join(",") } : {}),
      ...(patch.rendersPerHour !== undefined ? { renders_per_hour: patch.rendersPerHour } : {}),
      ...(patch.spendCapCents !== undefined ? { spend_cap_cents: patch.spendCapCents } : {}),
      ...(patch.endsDays !== undefined ? { expires_at: this.endOf(patch.endsDays) } : {}),
    }).where("id", "=", id).execute();
    return (await this.view(id))!;
  }

  /** A token revoked: refused from its next call on, kept in the list (greyed) while its activity is. */
  async revoke(id: string): Promise<void> {
    const was = await this.get(id);
    if (!was) throw notFound("That token");
    if (!was.revokedAt) await this.db.updateTable("mcp_tokens").set({ revoked_at: this.iso() }).where("id", "=", id).execute();
  }

  /**
   * The token an `Authorization: Bearer …` header names, when it is good: neither revoked nor ended. Found by its SHA-256,
   * which is all the database has: the look-up says nothing of the token itself.
   */
  async byBearer(header: string | undefined): Promise<McpToken | null> {
    const given = /^Bearer\s+(\S{10,200})\s*$/i.exec(header ?? "")?.[1];
    if (!given) return null;
    const row = await this.db.selectFrom("mcp_tokens").selectAll().where("hash", "=", sha256(given)).executeTakeFirst();
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= this.now())) return null;
    return viewOf(row);
  }

  /** A call made with it: its last use, at most once a minute unless the address or the client is new. */
  async touch(t: McpToken, ip: string, client?: string): Promise<void> {
    const name = client === undefined ? undefined : cleanName(client) || null;
    const same = t.lastIp === ip && (name === undefined || name === t.lastClient);
    if (same && t.lastUsedAt && this.now() - Date.parse(t.lastUsedAt) < TOUCH_MS) return;
    await this.db.updateTable("mcp_tokens").set({ last_used_at: this.iso(), last_ip: ip, ...(name !== undefined ? { last_client: name } : {}) }).where("id", "=", t.id).execute();
  }

  // ---------------------------------------------------------------- the activity

  /** A call written to its token's activity; the lines older than 30 days let go now and then, and the revoked tokens with nothing left. */
  async record(line: { tokenId: string; tool: string; said: string; refused: boolean; why?: string | null }): Promise<void> {
    await this.db.insertInto("mcp_activity").values({
      // its moment first, then a count of this run's: lines written in the same millisecond keep their order
      id: `${this.iso()}#${String(this.seq++ % 1e6).padStart(6, "0")}${newId().slice(0, 8)}`, token_id: line.tokenId, at: this.iso(), tool: line.tool, said: line.said.slice(0, 500), refused: line.refused ? 1 : 0, why: line.why?.slice(0, 500) ?? null,
    }).execute();
    if (this.now() - this.prunedAt > HOUR) await this.prune();
  }

  /** The activity older than 30 days let go, and the revoked tokens whose last line went with it. */
  async prune(): Promise<void> {
    this.prunedAt = this.now();
    const before = this.iso(this.now() - ACTIVITY_DAYS * DAY);
    await this.db.deleteFrom("mcp_activity").where("at", "<", before).execute();
    const gone = await this.db.selectFrom("mcp_tokens").select("id").where("revoked_at", "is not", null).where("revoked_at", "<", before).execute();
    for (const { id } of gone) {
      const left = await this.db.selectFrom("mcp_activity").select("id").where("token_id", "=", id).limit(1).executeTakeFirst();
      if (!left) await this.db.deleteFrom("mcp_tokens").where("id", "=", id).execute();
    }
  }

  /** A token's activity, the newest first: everything, or only what was refused. */
  async activity(id: string, o: { refusedOnly?: boolean; limit?: number } = {}): Promise<McpActivity[]> {
    let q = this.db.selectFrom("mcp_activity").selectAll().where("token_id", "=", id);
    if (o.refusedOnly) q = q.where("refused", "=", 1);
    const rows = await q.orderBy("id", "desc").limit(o.limit ?? 200).execute();
    return rows.map((r) => ({ id: r.id, at: r.at, tool: r.tool, said: r.said, refused: r.refused === 1, why: r.why }));
  }

  /** A token's activity of the last 30 days as a CSV file (csv.ts). */
  async activityCsv(id: string): Promise<string> {
    const lines = await this.activity(id, { limit: 100_000 });
    return csvOf(["at_utc", "tool", "said", "refused", "why"], lines.map((l) => [utc(Date.parse(l.at)), l.tool, l.said, l.refused, l.why]));
  }

  // ---------------------------------------------------------------- the limits

  /** Its renders sent in the last hour (a model load alone is no render). */
  async rendersThisHour(id: string): Promise<number> {
    const row = await this.db.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n"))
      .where("mcp_token_id", "=", id).where("warm", "=", 0).where("created_at", ">=", this.iso(this.now() - HOUR)).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * What its renders cost on rented GPUs since the start of this month (USD), as Costs counts a render: its length at the
   * hourly rate of the pod session it ran in. A render on a machine of the user's own costs nothing here.
   */
  async spentThisMonth(id: string): Promise<number> {
    return (await this.spentThisMonthOf([id])).get(id) ?? 0;
  }

  private async spentThisMonthOf(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const d = new Date(this.now());
    const from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1).getTime());
    const renders = await this.db.selectFrom("render_stats").innerJoin("jobs", "jobs.id", "render_stats.id")
      .select(["jobs.mcp_token_id", "render_stats.total_ms", "render_stats.machine_id", "render_stats.created_at", "render_stats.started_at"])
      .where("jobs.mcp_token_id", "in", ids).where("render_stats.created_at", ">=", from).execute();
    const machines = [...new Set(renders.map((r) => r.machine_id).filter((m): m is string => Boolean(m)))];
    if (!machines.length) return out;
    // the sessions of those machines that may hold one of them: begun before the render's end, not ended before the month
    const sessions = await this.db.selectFrom("rent_sessions").select(["machine_id", "rate", "started_at", "ended_at"])
      .where("machine_id", "in", machines).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">=", from)])).execute();
    for (const r of renders) {
      const at = Date.parse(r.started_at ?? r.created_at);
      const s = sessions.find((x) => x.machine_id === r.machine_id && Date.parse(x.started_at) <= at && (!x.ended_at || Date.parse(x.ended_at) >= at));
      if (!s || !r.mcp_token_id) continue;
      out.set(r.mcp_token_id, (out.get(r.mcp_token_id) ?? 0) + (r.total_ms / HOUR) * s.rate);
    }
    return out;
  }

  /** Whether this token may send `count` renders more now: refused past its renders an hour. */
  async mayRender(t: McpToken, count = 1): Promise<void> {
    const sent = await this.rendersThisHour(t.id);
    if (sent + count > t.rendersPerHour) {
      throw refusal(`This token's limit is ${plural(t.rendersPerHour, "render")} an hour, and ${sent} went in the last hour: raise it in Settings › Interface › Access, or wait.`);
    }
  }

  /**
   * Whether this token may spend `usd` more on rented GPUs: Spend ticked, and this month's spend and that under its own cap.
   * The app's own caps (rentCaps) still hold over every token; this is one more, of the token's.
   */
  async maySpend(t: McpToken, usd: number): Promise<void> {
    if (!t.scopes.includes("spend")) throw refusal("This token cannot spend on rented GPUs: tick Spend on it in Settings › Interface › Access.");
    const spent = await this.spentThisMonth(t.id);
    const cap = t.spendCapCents / 100;
    if (spent + usd > cap) throw refusal(`This token's cap is ${dollars(cap)} a month on rented GPUs, and it has spent ${dollars(spent)}: raise it in Settings › Interface › Access.`);
  }
}
