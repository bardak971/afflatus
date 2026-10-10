import type { Llm } from "./settings";

/**
 * Talking to a language model (any OpenAI-style address, set in Settings): one exchange, what fits in its context,
 * why it did not answer, and a conversation as it is stored. The prompt designer (designer-api.ts) is its one user.
 */

/**
 * Why a call never got an answer, in words: Node says "fetch failed" for every network failure and keeps
 * the reason in the error's cause (the address did not resolve, nothing listens there, it timed out).
 */
function whyNoAnswer(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string }; name?: string };
  const code = e.cause?.code ?? "";
  if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "it took too long to answer (timed out).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the address could not be found: no internet connection, or the address is misspelt.";
  if (code === "ECONNREFUSED") return "nothing is listening at that address: the server is not running, or the port is wrong.";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the connection was cut while waiting.";
  if (code === "CERT_HAS_EXPIRED" || /certificate/i.test(e.cause?.message ?? "")) return `its certificate was refused (${e.cause?.message}).`;
  return e.cause?.message ? `${e.message} (${e.cause.message}).` : `${e.message}.`;
}

/**
 * What a refusal said, short: the error message of an OpenAI-style answer, else the first line of the body
 * without markup. The base URL can be any address (another service on the network), whose page is not
 * Afflatus's to pass on whole.
 */
export function refusal(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const said = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? j.detail;
    if (typeof said === "string" && said.trim()) return said.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    /* not JSON */
  }
  return (body.trim().split(/\r?\n/)[0] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export class DesignerError extends Error {
  statusCode = 400;
}

/** The language model failed us (no answer, a refusal, nothing usable): the server in front of it answers 502, not the asker's 400. */
export class UpstreamError extends DesignerError {
  override statusCode = 502;
}

/**
 * A conversation as it is stored with a draft or a clip. One that outgrows its room loses its oldest
 * exchanges: cutting the text itself would leave something that cannot be read back at all.
 */
export function chatJson(chat: unknown[], most = 256 * 1024): string | null {
  let kept = chat;
  let json = JSON.stringify(kept);
  while (json.length > most && kept.length > 2) {
    kept = kept.slice(2);
    json = JSON.stringify(kept);
  }
  return kept.length && json.length <= most ? json : null;
}

export type Message = { role: "system" | "user" | "assistant"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

/** Roughly how many tokens a text is: enough to know what fits, with room to spare. */
export const tokensOf = (content: Message["content"]): number =>
  typeof content === "string" ? Math.ceil(content.length / 3.5) : content.reduce((n, part) => n + (part.type === "text" ? Math.ceil(part.text.length / 3.5) : 1200), 0);

/**
 * The end of a conversation that fits in what the model can read: its context, less the answer it may
 * write and what it is told first. The oldest turns go; the last thing said always stays.
 */
export function fitting(cfg: Llm, system: string, history: Message[]): Message[] {
  let room = cfg.contextSize - cfg.maxOutputTokens - tokensOf(system) - 200;
  const kept: Message[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    room -= tokensOf(history[i]!.content);
    if (room < 0 && kept.length) break;
    kept.unshift(history[i]!);
  }
  // a conversation starts with what the user said
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();
  return kept;
}

/** What one exchange came back with: the answer, whether the model thought before it (a <think> part, or a reasoning field), and how long it took. */
export interface Reply { said: string; thought: boolean; ms: number }

/** One plain exchange with the language model, with what else came back. A busy server is asked a second time. */
export async function ask(cfg: Llm | undefined, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<Reply> {
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) throw new DesignerError("The designer has no language model yet. Give it one in Settings.");
  const started = Date.now();
  const send = () =>
    fetch(`${cfg.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model, messages, stream: false, max_tokens: opts.maxTokens ?? cfg.maxOutputTokens, temperature: opts.temperature ?? 0.6,
        // asked not to think first: the field llama.cpp, vLLM and SGLang read, and the one Ollama reads
        ...(cfg.noThinking ? { chat_template_kwargs: { enable_thinking: false }, think: false } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  let res: Response;
  try {
    res = await send();
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await send();
    }
  } catch (err) {
    throw new UpstreamError(`The language model did not answer at ${cfg.baseUrl}: ${whyNoAnswer(err)}`);
  }
  if (!res.ok) throw new UpstreamError(`The language model refused (${res.status}): ${refusal(await res.text().catch(() => ""))}`);
  const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> };
  const message = data.choices?.[0]?.message;
  const raw = message?.content ?? "";
  const thought = /<think>/i.test(raw) || Boolean(message?.reasoning_content || message?.reasoning);
  // a model that thinks before it answers may leave its thinking in the answer: it is not part of it
  const said = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
  if (!said && data.choices?.[0]?.finish_reason === "length") {
    throw new UpstreamError(`The language model used its whole answer (${opts.maxTokens ?? cfg.maxOutputTokens} tokens) before it wrote anything, as a model that thinks first can. Raise "Max output tokens" for it in Settings.`);
  }
  return { said, thought, ms: Date.now() - started };
}

/** One plain exchange with the language model: its answer. */
export async function chat(cfg: Llm | undefined, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  return (await ask(cfg, messages, opts)).said;
}
