import { ProtocolError, ProtocolErrorCode, type CallToolResult } from "@modelcontextprotocol/server";
import { plural } from "@afflatus/core";
import { z } from "zod";
import { newId, type Tables } from "./db";
import { machineName } from "./mcpForms";
import { jobEnded, mayTouch } from "./mcpRender";
import { quoted, type Follow, type Tool, type ToolCtx } from "./mcpTool";
import { refusal, SCOPE_WORDS, type McpToken } from "./mcpTokens";
import { readJson } from "./queueModel";
import { readSettings } from "./settings";
import type { Services } from "./services";

/**
 * MCP Tasks (the io.modelcontextprotocol/tasks extension of protocol 2026-07-28; owner, 2026-10-29): a long call answered
 * with a task the client follows, rather than an answer the agent then polls `job` about. The client asks `tasks/get` at the
 * interval the task gives, on its own, and hands the agent the result once the work has ended: the agent spends nothing on
 * the wait. No progress is sent (owner: "all those calls consume tokens for nothing").
 *
 * Offered only to a client that declares the extension in the request's own capabilities (`_meta`); any other gets the
 * answer as before. The call itself is the same call, through mcp.ts's `call` (its scope, limits, money rules and activity
 * line): a task only changes how its answer reaches the client. What the task waits for is the tool's to say (Tool.task):
 * the jobs the call queued, or the pod it deployed until its ComfyUI answers. Its state is read from them each time it is
 * asked, so a restart of Afflatus loses nothing; the result is kept once it is seen, and never changes after.
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** How long a task can be asked about after it was made: a day, a render's longest wait in the queue and more. */
const TASK_TTL_MS = 24 * 3600_000;

/**
 * The client declared the Tasks extension in this request's own capabilities: the envelope every 2026-07-28 request carries
 * in its `_meta`, which the SDK hands the handler apart (none on the 2025 handshake: no task then).
 */
export function takesTasks(envelope: unknown): boolean {
  const caps = z.object({ "io.modelcontextprotocol/clientCapabilities": z.object({ extensions: z.record(z.string(), z.unknown()) }) }).safeParse(envelope);
  return caps.success && TASKS_EXTENSION in caps.data["io.modelcontextprotocol/clientCapabilities"].extensions;
}

type Status = "working" | "completed" | "cancelled";

/** A task as the wire says it (its base fields; a completed one adds `result`). */
function wire(row: Pick<Tables["mcp_tasks"], "id" | "created_at" | "updated_at">, status: Status, o: { pollMs?: number; message?: string } = {}) {
  return {
    taskId: row.id, status, createdAt: row.created_at, lastUpdatedAt: row.updated_at, ttlMs: TASK_TTL_MS,
    ...(o.pollMs ? { pollIntervalMs: o.pollMs } : {}),
    ...(o.message ? { statusMessage: o.message } : {}),
  };
}

/** The answer a call would have sent, as a tool result: on the 2026-07-28 wire, inline in a task too, it says it is complete. */
const asResult = (value: unknown): CallToolResult & { resultType: "complete" } => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/**
 * The task a call answers with, when its tool waits for something and the client takes tasks: the call's own answer kept
 * with what it waits for. Null when there is nothing to wait for (the answer is sent as it is).
 */
export async function taskOf(s: Services, t: Tool, token: McpToken, answer: unknown) {
  const follow = t.task?.(answer) ?? null;
  if (!follow || ("jobs" in follow && !follow.jobs.length)) return null;
  const at = new Date();
  const row = { id: newId(), token_id: token.id, tool: t.name, answer: JSON.stringify(answer), follow: JSON.stringify(follow), status: "working", result: null, created_at: at.toISOString(), updated_at: at.toISOString(), expires_at: new Date(at.getTime() + TASK_TTL_MS).toISOString() };
  // the task is kept before it is answered (the extension's rule): a client that asks at once finds it
  await s.db.insertInto("mcp_tasks").values(row).execute();
  // the tasks a day old are forgotten as new ones come
  await s.db.deleteFrom("mcp_tasks").where("expires_at", "<", at.toISOString()).execute();
  return { resultType: "task" as const, ...wire(row, "working", { pollMs: 5000 }) };
}

/** A task of this token, not yet forgotten; refused as one that does not exist otherwise (another token's included). */
async function taskRow(s: Services, token: McpToken, taskId: string): Promise<Tables["mcp_tasks"]> {
  const row = await s.db.selectFrom("mcp_tasks").selectAll().where("id", "=", taskId).where("token_id", "=", token.id).executeTakeFirst();
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "There is no such task: it was never made by this token, or it is more than a day old.");
  return row;
}

/** How a task's work stands now: still going (with when to ask again), or ended with the result the call's answer grows. */
async function standing(s: Services, row: Tables["mcp_tasks"]): Promise<{ ended: false; pollMs: number; message: string } | { ended: true; result: ReturnType<typeof asResult> }> {
  const answer = readJson<Record<string, unknown>>(row.answer, {});
  const follow = readJson<Follow>(row.follow, { jobs: [] });
  if ("pod" in follow) {
    const m = (await readSettings(s.db)).machines.find((x) => x.id === follow.pod);
    if (!m?.rented) return { ended: true, result: asResult({ ...answer, ready: false, said: "The pod is gone from Afflatus (terminated)." }) };
    const v = s.rented.view(m);
    if (v?.answers) return { ended: true, result: asResult({ ...answer, ready: true, said: `${machineName(m)}'s ComfyUI answers: it takes renders now.` }) };
    // stopped or gone before its ComfyUI answered: the task ends, said as the pod is
    if (v && (v.status === "EXITED" || v.status === "TERMINATED" || v.status === "GONE" || v.stoppedBy)) {
      return { ended: true, result: asResult({ ...answer, ready: false, status: v.status, ...(v.stoppedBy ? { stoppedBy: v.stoppedBy } : {}), ...(v.error ? { error: v.error } : {}) }) };
    }
    return { ended: false, pollMs: 15_000, message: v?.boot ? "booting" : "starting" };
  }
  const rows = follow.jobs.length ? await s.db.selectFrom("jobs").selectAll().where("id", "in", follow.jobs).execute() : [];
  const going = rows.filter((r) => r.status === "queued" || r.status === "running");
  if (!going.length) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ended = [];
    for (const id of follow.jobs) {
      const r = byId.get(id);
      ended.push(r ? await jobEnded(s, r) : { job: id, status: "gone", said: "this job is no longer in the queue's history" });
    }
    return { ended: true, result: asResult({ ...answer, ended }) };
  }
  // asked again when the last of them should end, from the queue's forecast: seldom while the wait is long
  const st = await s.queue.statusRecent();
  let leftMs = 0;
  for (const r of going) {
    const running = st.machines.find((m) => m.running?.id === r.id)?.running as { eta?: number } | undefined;
    const waiting = st.waiting.find((w) => w.id === r.id) as { estimateMs?: number | null; startsInMs?: number | null } | undefined;
    leftMs = Math.max(leftMs, running?.eta ? running.eta * 1000 : waiting?.estimateMs ? (waiting.startsInMs ?? 0) + waiting.estimateMs : 0);
  }
  const running = going.filter((r) => r.status === "running").length;
  return {
    ended: false,
    pollMs: leftMs ? Math.min(60_000, Math.max(5000, Math.round(leftMs / 3))) : 15_000,
    message: `${running} running, ${going.length - running} waiting, of ${follow.jobs.length}`,
  };
}

/** tasks/get: the task as it stands, its result inline once the work has ended. */
export async function getTask(s: Services, token: McpToken, taskId: string) {
  const row = await taskRow(s, token, taskId);
  if (row.status !== "working") {
    return row.status === "completed" ? { ...wire(row, "completed"), result: readJson<CallToolResult>(row.result ?? "", { content: [] }) } : wire(row, "cancelled");
  }
  const now = await standing(s, row);
  if (!now.ended) return wire(row, "working", { pollMs: now.pollMs, message: now.message });
  // kept as it is seen ending: a terminal task never changes after
  const at = new Date().toISOString();
  const kept = await s.db.updateTable("mcp_tasks").set({ status: "completed", result: JSON.stringify(now.result), updated_at: at }).where("id", "=", row.id).where("status", "=", "working").executeTakeFirst();
  if (!Number(kept.numUpdatedRows)) return getTask(s, token, taskId);
  return { ...wire({ ...row, updated_at: at }, "completed"), result: now.result };
}

/**
 * tasks/cancel: the task's jobs still waiting or running cancelled, as `cancel` cancels them (its scope, and a job of
 * another token's refused), and the task ended as cancelled. A pod's task only stops being followed: the pod stays up,
 * billed, until its idle stop or stop_pod (a client that cancels on leaving must not terminate the user's pod). Written to
 * the token's activity as a cancel is.
 */
export async function cancelTask(s: Services, ctx: ToolCtx, taskId: string): Promise<void> {
  const { token } = ctx;
  const row = await taskRow(s, token, taskId);
  if (row.status !== "working") return;
  const follow = readJson<Follow>(row.follow, { jobs: [] });
  let said = `Cancelled the task of ${row.tool}`;
  try {
    if (!token.scopes.includes("make")) throw refusal(`This token cannot cancel (it needs ${SCOPE_WORDS.make}): tick ${SCOPE_WORDS.make} on it in Settings › Agents (MCP).`);
    if ("jobs" in follow) {
      const going = follow.jobs.length ? await s.db.selectFrom("jobs").selectAll().where("id", "in", follow.jobs).where("status", "in", ["queued", "running"]).execute() : [];
      for (const r of going) await mayTouch(s, ctx, r);
      // only what this token queued: a task that joined a job of the user's already on its way (an export asked twice, a
      // clip's take already waiting) follows it, and a client cancelling the task on leaving must not stop the user's work
      // (card #188). Its own held in the write too
      const mine = going.filter((r) => r.mcp_token_id === token.id);
      const cancelled: string[] = [];
      for (const r of mine) if (await s.queue.cancel(r.id, { mcpToken: token.id, mine: true })) cancelled.push(quoted(r.label));
      const left = going.length - cancelled.length;
      said = `${said}: cancelled ${cancelled.join(", ") || "nothing"}${!going.length ? " (its jobs had ended)" : left ? `; ${plural(left, "job")} not queued by this token left as ${left === 1 ? "it is" : "they are"}` : ""}`;
    } else said = `${said}: the pod stays up (its idle stop, or stop_pod, stops it)`;
  } catch (err) {
    await s.mcp.tokens.record({ tokenId: token.id, tool: "tasks/cancel", said: `${said}: refused`, refused: true, why: (err as Error).message }).catch((e) => console.warn("[mcp] activity not written:", (e as Error).message));
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, (err as Error).message);
  }
  await s.db.updateTable("mcp_tasks").set({ status: "cancelled", updated_at: new Date().toISOString() }).where("id", "=", row.id).where("status", "=", "working").execute();
  await s.mcp.tokens.record({ tokenId: token.id, tool: "tasks/cancel", said, refused: false }).catch((e) => console.warn("[mcp] activity not written:", (e as Error).message));
}
