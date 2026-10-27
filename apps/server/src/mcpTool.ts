import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { McpToken, Scope } from "./mcpTokens";
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
} as const;
export type NeverSubject = keyof typeof NEVER;

/** Whether a subject is on the never-list (a dotted subject by its first part: "access.stayDays" is "access"). */
export const isNever = (subject: string): subject is NeverSubject => (subject.split(".")[0] ?? "") in NEVER;

/** What a tool's run is given. */
export interface ToolCtx {
  s: Services;
  token: McpToken;
  /** The client's address. */
  ip: string;
  /** What the call touched, in plain words, for the activity ("Looked at the queue: 2 waiting"); the tool's title when not said. */
  said(text: string): void;
  /** Refuses the call at once when `subject` is on the never-list: for a tool whose subject is known only as it runs. */
  never(subject: string): void;
  /** Refuses past the token's renders an hour (mcpTokens.ts mayRender). */
  mayRender(count?: number): Promise<void>;
  /** Refuses without Spend, or past the token's spend cap this month (mcpTokens.ts maySpend). */
  maySpend(usd: number): Promise<void>;
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
}

/** A tool written with its arguments' types: `tool({ name, scope, …, run })`. */
export const tool = <S extends z.ZodRawShape>(t: Tool<S>): Tool<S> => t;

/** An answer sent as MCP content as it is (a picture, a sound, several parts), rather than as JSON text. */
export class Rich {
  constructor(readonly content: CallToolResult["content"]) {}
}
