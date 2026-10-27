import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sendCsv } from "./csv";
import { SCOPES, STARTS } from "./mcpTokens";
import type { Services } from "./services";

/**
 * Settings › Interface › Access › Agents (MCP): the tokens made, changed, revoked and listed, each one's activity (and as
 * CSV), and where each page is (whatsOpen.ts). Behind the lock as every API route: an MCP token is never taken here.
 *
 * Making a token, and changing its scopes, limits or end or revoking it, loosen or tighten what an agent may do: each needs
 * a sign-in of the last 10 minutes or the password with it (access.ts mayChange), as the Access settings and Telegram's
 * bot do. A new name alone does not.
 */

const current = z.string().max(2000).optional();
const ends = z.union([z.null(), z.literal(30), z.literal(90)]);
const makeBody = z.strictObject({ name: z.string().max(200), start: z.enum(Object.keys(STARTS) as [keyof typeof STARTS]), current });
const changeBody = z.strictObject({
  name: z.string().max(200).optional(),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length).optional(),
  rendersPerHour: z.number().int().min(1).max(1000).optional(),
  spendCapUsd: z.number().min(0).max(10_000).optional(),
  endsDays: ends.optional(),
  current,
});
const revokeBody = z.strictObject({ current });
const params = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });
const itemId = z.string().regex(/^[\w-]{1,64}$/).nullish();
const whereBody = z.strictObject({ key: z.string().regex(/^[\w-]{8,64}$/), path: z.string().max(400).regex(/^\//), draft: itemId, timeline: itemId, clip: itemId });

export function registerMcpTokens(app: FastifyInstance, s: Services): void {
  const tokens = s.mcp.tokens;
  const ip = (req: FastifyRequest) => req.socket.remoteAddress ?? "";

  app.get("/api/mcp/tokens", async () => ({ tokens: await tokens.list() }));

  /** A new token: shown this once, in the answer. */
  app.post("/api/mcp/tokens", async (req) => {
    const b = makeBody.parse(req.body);
    await s.access.mayChange(req.access.session, b.current, ip(req));
    const made = await tokens.make({ name: b.name, scopes: STARTS[b.start] });
    await s.access.audit(`MCP token "${made.view.name}" made (${made.view.scopes.join(", ")}), from ${ip(req)}`);
    return made;
  });

  app.post("/api/mcp/tokens/:id", async (req) => {
    const { id } = params.parse(req.params);
    const { current: password, spendCapUsd, ...b } = changeBody.parse(req.body);
    const loosens = b.scopes !== undefined || b.rendersPerHour !== undefined || spendCapUsd !== undefined || b.endsDays !== undefined;
    if (loosens) await s.access.mayChange(req.access.session, password, ip(req));
    const view = await tokens.change(id, { ...b, ...(spendCapUsd !== undefined ? { spendCapCents: Math.round(spendCapUsd * 100) } : {}) });
    if (loosens) await s.access.audit(`MCP token "${view.name}" changed: ${JSON.stringify({ ...b, ...(spendCapUsd !== undefined ? { spendCapUsd } : {}) })}, from ${ip(req)}`);
    // its jobs waiting may go to a rented pod now, or no longer (queuePlan.ts ownOnly): the queue makes a pass, as when a
    // machine's families change ("setup" starts one)
    if (b.scopes) s.queue.events.emit("setup");
    return { token: view };
  });

  /** Revoked: its client is refused from its next call. */
  app.post("/api/mcp/tokens/:id/revoke", async (req) => {
    const { id } = params.parse(req.params);
    const b = revokeBody.parse(req.body ?? {});
    await s.access.mayChange(req.access.session, b.current, ip(req));
    await tokens.revoke(id);
    await s.access.audit(`MCP token ${id} revoked, from ${ip(req)}`);
    return { ok: true };
  });

  app.get("/api/mcp/tokens/:id/activity", async (req) => {
    const { id } = params.parse(req.params);
    const q = z.object({ refused: z.enum(["0", "1"]).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { lines: await tokens.activity(id, { refusedOnly: q.refused === "1", limit: q.limit ?? 100 }) };
  });

  app.get("/api/mcp/tokens/:id/activity.csv", async (req, reply) => {
    const { id } = params.parse(req.params);
    const t = await tokens.get(id);
    const name = (t?.name ?? "token").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "token";
    return sendCsv(reply, `afflatus-mcp-${name}-activity.csv`, await tokens.activityCsv(id));
  });

  /**
   * A page says where it is (App.tsx useWhereReport), for `whats_open`. Its browser is told apart by its session when it has
   * one, else by a key of its own it sends.
   */
  app.post("/api/where", async (req) => {
    const b = whereBody.parse(req.body);
    s.mcp.where.said(req.access.session ?? b.key, String(req.headers["user-agent"] ?? ""), { path: b.path, draft: b.draft ?? null, timeline: b.timeline ?? null, clip: b.clip ?? null });
    return { ok: true };
  });
}
