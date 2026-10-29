import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { cleanLine, type McpToken, type Scope, type SpendSaid } from "./mcpTokens";
import type { Services } from "./services";

/**
 * How an MCP tool is written (mcpTools.ts has them, mcp.ts runs them): `tool({ name, scope, title, description, input,
 * touches?, run })`. Kept apart from mcp.ts, which imports the tools.
 */

/**
 * What is never reachable through MCP, whatever the token's scopes (owner, 2026-10-27): the account's own security, what
 * acts on this computer's desktop or installs, and Afflatus's own updates. A tool says what it touches (`touches`, or
 * `ctx.never` as it runs); a subject on this list refuses the call. Later tools generated from the settings map their keys
 * here (an Access setting is "access", Telegram's bot and chat "notify-channels").
 */
export const NEVER = {
  password: "the password",
  access: "the Access settings",
  tokens: "tokens (MCP, metrics, a ComfyUI's)",
  lock: "Lock",
  "sign-out": "signing devices out",
  // where reset codes and the new-device notice go: pointing them elsewhere would hand the account over
  "notify-channels": "where notices and reset codes go (Telegram, Discord)",
  "show-in-folder": "Show in folder",
  "get-ffmpeg": "Get ffmpeg",
  updates: "Afflatus's updates",
  // the user's check of what an agent's workflow runs and reaches (#133's W1): an agent approving it would check itself
  "approve-workflow": "approving a workflow",
  // code put on a machine, then a ComfyUI restart
  "node-packs": "installing node packs",
  // a network volume's files have no bin: deleted there, they are gone
  "volume-files": "deleting a network volume or its files",
  // the estimates and every cap are worked out from them
  "render-times": "forgetting the render times",
  backups: "backups of the database",
  // it goes out to the notify channels, beyond Afflatus
  share: "sharing an item",
  "link-folder": "linking or unlinking a folder of the disk",
  // Settings › Model files' Delete and Empty: a model file erased is a download of many gigabytes again
  "model-files": "deleting model files",
} as const;
export type NeverSubject = keyof typeof NEVER;

/** Whether a subject is on the never-list (a dotted subject by its first part: "access.stayDays" is "access"). */
export const isNever = (subject: string): subject is NeverSubject => (subject.split(".")[0] ?? "") in NEVER;

/**
 * A name an agent gave (a label, a file, a folder, a tool it asked for) as an activity line or a refusal says it: in quotes
 * of its own, its own curly quotes made straight, so that it cannot close them and go on as if Afflatus said the rest.
 */
export const quoted = (name: string) => `“${cleanLine(name).replace(/[“”]/g, '"').trim().slice(0, 120)}”`;

/** What a tool's run is given. */
export interface ToolCtx {
  s: Services;
  token: McpToken;
  /** The client's address. */
  ip: string;
  /** The address this request reached Afflatus at (fetchFile.ts selfUrl): where a ComfyUI fetches a download from. */
  self: string;
  /** What the call touched, in plain words, for the activity ("Looked at the queue: 2 waiting"); the tool's title when not said. */
  said(text: string): void;
  /** Refuses the call at once when `subject` is on the never-list: for a tool whose subject is known only as it runs. */
  never(subject: string): void;
  /** Refuses past the token's renders an hour (mcpTokens.ts mayRender). */
  mayRender(count?: number): Promise<void>;
  /** Refuses without Spend, or past the token's spend cap this month (mcpTokens.ts maySpend), naming `said`'s parts. */
  maySpend(usd: number, said?: SpendSaid): Promise<void>;
}

/** A tool: its name, its scope, its words, its arguments, and what it does. */
export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  scope: Scope;
  title: string;
  /** What it does, for the agent: power-user words, as the "?" of the page says it. */
  description: string;
  input?: S;
  /** What it touches, for the never-list: subjects, or a function of its arguments. */
  touches?: readonly string[] | ((args: z.output<z.ZodObject<S>>) => readonly string[]);
  /** What it answers: anything JSON (sent as text), or a `Rich` answer (pictures, sound) as it is. */
  run(args: z.output<z.ZodObject<S>>, ctx: ToolCtx): Promise<unknown>;
  /**
   * For a tool that starts long work: what its answer leaves to wait for (its jobs, or a pod until its ComfyUI answers), or
   * null when there is nothing (a cut by ffmpeg). A client that takes MCP Tasks then gets a task to follow rather than the
   * answer (mcpTasks.ts), and its result once the work has ended.
   */
  task?(answer: any): Follow | null;
}

/** What a task waits for: jobs of the queue to end, or a pod (a machine id) until its ComfyUI answers. */
export type Follow = { jobs: string[] } | { pod: string };

/** A tool written with its arguments' types: `tool({ name, scope, …, run })`. */
export const tool = <S extends z.ZodRawShape>(t: Tool<S>): Tool<S> => t;

/** An answer sent as MCP content as it is (a picture, a sound, several parts), rather than as JSON text. */
export class Rich {
  constructor(readonly content: CallToolResult["content"]) {}
}
