import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { VERSION } from "./config";
import { isNever, NEVER, quoted, Rich, type NeverSubject, type Tool, type ToolCtx } from "./mcpTool";
import { selfUrl } from "./fetchFile";
import { refusal, SCOPE_WORDS, type McpToken } from "./mcpTokens";
import { UPLOAD_MOST } from "./mcpLibrary";
import { TOOLS } from "./mcpTools";
import type { Services } from "./services";

/**
 * Afflatus from outside: /mcp, on the same port as the app, where an MCP client (Claude Desktop, Claude Code, Cursor…)
 * drives Afflatus with a personal token (mcpTokens.ts) as far as its scopes go. Streamable HTTP through the official SDK,
 * stateless: each POST is answered on its own (JSON), so that nothing is held between calls and a restart loses nothing.
 *
 * The token is the only way in, and only here: `Authorization: Bearer afl_mcp_…`, whether a password is set or not. The
 * lock (access-api.ts) leaves /mcp to this route; the host check (hostCheck.ts) applies as to every address, and the
 * page-origin checks too, since no page of another site has anything to do here.
 *
 * Every tool goes through `call` below, which every later tool uses (a tool itself is written as mcpTool.ts says): a
 * declared scope checked before it runs, the never-list refused whatever the scopes, the token's limits as helpers, the
 * same errors the web gives (the services throw them), and every call written to the token's activity.
 */

/**
 * An error said as the web says it: its message when it was written to be read, else the server's plain line (logged).
 * `failed`: the server's own failure (a 5xx, or an error nobody wrote to be read), written so in the activity; anything
 * else is a refusal (a scope, the never-list, a limit, a value the form would refuse, the app's own checks).
 */
function errorSaid(err: unknown, tool: string): { why: string; failed: boolean } {
  if (err instanceof ZodError) return { why: err.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; "), failed: false };
  const code = (err as { statusCode?: number }).statusCode;
  if (code && code < 500) return { why: (err as Error).message, failed: false };
  if (code) return { why: (err as Error).message, failed: true };
  console.error(`[mcp] ${tool} failed:`, err);
  return { why: "something went wrong on the server", failed: true };
}

/** The answer of a call, as MCP sends it. */
function resultOf(value: unknown): CallToolResult {
  if (value instanceof Rich) return { content: value.content };
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** One call of a tool, checked, run and written down. */
async function call(t: Tool, raw: unknown, s: Services, token: McpToken, ip: string, self: string): Promise<CallToolResult> {
  let said = t.title;
  const ctx: ToolCtx = {
    s, token, ip, self,
    said: (text) => void (said = text),
    never: (subject) => {
      if (!isNever(subject)) return;
      said = `${NEVER[subject.split(".")[0] as NeverSubject]}: never through MCP`;
      throw refusal(`${NEVER[subject.split(".")[0] as NeverSubject]} cannot be reached through MCP, whatever the token's scopes: do it in Afflatus itself.`);
    },
    mayRender: (count = 1) => s.mcp.tokens.mayRender(token, count),
    maySpend: (usd, said) => s.mcp.tokens.maySpend(token, usd, said),
  };
  let value: unknown;
  try {
    // the scope first: a token that may not use the tool is told what to tick, not that its arguments are wrong
    if (!token.scopes.includes(t.scope)) {
      said = `${t.title}: needs ${SCOPE_WORDS[t.scope]}`;
      throw refusal(`This token cannot ${t.scope === "spend" ? "spend on rented GPUs" : `do this (it needs ${SCOPE_WORDS[t.scope]})`}: tick ${SCOPE_WORDS[t.scope]} on it in Settings › Access.`);
    }
    // the arguments checked here rather than by the SDK, so that a refused one is in the activity too
    const parsed = z.object(t.input ?? {}).safeParse(raw ?? {});
    if (!parsed.success) {
      said = `${t.title}: arguments refused`;
      throw parsed.error;
    }
    const args = parsed.data as Record<string, unknown>;
    for (const subject of typeof t.touches === "function" ? t.touches(args) : (t.touches ?? [])) ctx.never(subject);
    value = await t.run(args, ctx);
  } catch (err) {
    const { why, failed } = errorSaid(err, t.name);
    await s.mcp.tokens.record({ tokenId: token.id, tool: t.name, said, refused: !failed, failed, why }).catch((e) => console.warn("[mcp] activity not written:", (e as Error).message));
    return { content: [{ type: "text", text: why }], isError: true };
  }
  // done: a line that cannot be written must not say a done action failed (the agent would do it again: a render, a pod)
  await s.mcp.tokens.record({ tokenId: token.id, tool: t.name, said, refused: false }).catch((e) => console.warn("[mcp] activity not written:", (e as Error).message));
  return resultOf(value);
}

/** A call of a tool this server does not have: refused, and written to the token's activity like any other. */
async function unknownTool(name: string, s: Services, token: McpToken): Promise<CallToolResult> {
  const why = `There is no tool called ${quoted(name)}: the client's tool list has them.`;
  await s.mcp.tokens.record({ tokenId: token.id, tool: "(unknown)", said: `Asked for a tool that does not exist: ${quoted(name)}`, refused: true, why }).catch((e) => console.warn("[mcp] activity not written:", (e as Error).message));
  return { content: [{ type: "text", text: why }], isError: true };
}

/** The MCP server of one request: every tool, bound to the token that asked. */
/** `self`: the address the request reached Afflatus at (fetchFile.ts selfUrl). */
export function serverFor(s: Services, token: McpToken, ip: string, tools: readonly Tool[] = TOOLS, self = "http://127.0.0.1"): McpServer {
  const server = new McpServer({ name: "afflatus", title: "Afflatus", version: VERSION }, {
    instructions: "Afflatus is a self-hosted studio in front of ComfyUI. Start with whats_open (where the user is) and overview (machines, queue, caps). A tool this token's scopes do not cover is refused with what to tick.",
  });
  for (const t of tools) {
    server.registerTool(t.name, {
      title: t.title,
      description: t.scope === "look" ? t.description : `${t.description} Needs ${SCOPE_WORDS[t.scope]}.`,
      inputSchema: t.input ?? {},
      annotations: { title: t.title, readOnlyHint: t.scope === "look", openWorldHint: false },
    }, (args: Record<string, unknown>) => call(t, args, s, token, ip, self));
  }
  // tools/call answered here rather than by the SDK, which checks the arguments (and refuses an unknown tool) before any
  // of ours runs: those refusals went unwritten in the activity, and a token without the scope was told its arguments were
  // wrong. The tool list (tools/list, with each one's schema) stays the SDK's
  const byName = new Map(tools.map((t) => [t.name, t]));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const t = byName.get(request.params.name);
    return t ? call(t, request.params.arguments, s, token, ip, self) : unknownTool(request.params.name, s, token);
  });
  return server;
}

/** The client's name, when this request is its initialize: what the token's last use names it by. */
export function clientOf(body: unknown): string | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    const parsed = z.object({ method: z.literal("initialize"), params: z.object({ clientInfo: z.object({ name: z.string(), title: z.string().optional() }) }) }).safeParse(m);
    if (parsed.success) return parsed.data.params.clientInfo.title || parsed.data.params.clientInfo.name;
  }
  return undefined;
}

/**
 * The most a call to /mcp may weigh: an upload's file as base64 (UPLOAD_MOST, a third more) with room for the rest of the
 * call. Above the app's 8 MB for every other route, so read only once its token is known (onRequest, before the body).
 */
const MCP_BODY_MOST = Math.ceil((UPLOAD_MOST * 4) / 3) + 2 ** 20;

export function registerMcp(app: FastifyInstance, s: Services): void {
  const tokenOf = new WeakMap<object, McpToken>();
  app.post("/mcp", {
    bodyLimit: MCP_BODY_MOST,
    // the token checked before the body is read: a client without one is never given the room an upload has
    onRequest: async (req, reply) => {
      const token = await s.mcp.tokens.byBearer(req.headers.authorization);
      if (!token) {
        return reply.status(401).header("WWW-Authenticate", 'Bearer realm="afflatus"').header("Cache-Control", "no-store")
          .send({ error: "/mcp needs a token of Settings › Access as a Bearer token: none was sent, or it is wrong, revoked or ended." });
      }
      tokenOf.set(req, token);
    },
  }, async (req, reply) => {
    const token = tokenOf.get(req)!;
    const ip = req.socket.remoteAddress ?? "";
    await s.mcp.tokens.touch(token, ip, clientOf(req.body));
    const server = serverFor(s, token, ip, TOOLS, selfUrl(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // the transport writes the answer itself
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "something went wrong on the server" }, id: null }));
    }
  });
  // stateless: no stream to open, no session to end
  const notHere = { jsonrpc: "2.0", error: { code: -32000, message: "Afflatus's /mcp answers POST only (stateless Streamable HTTP)." }, id: null };
  app.get("/mcp", async (_req, reply) => reply.status(405).header("Allow", "POST").send(notHere));
  app.delete("/mcp", async (_req, reply) => reply.status(405).header("Allow", "POST").send(notHere));
}
