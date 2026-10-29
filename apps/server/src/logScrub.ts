import { withoutPaths } from "./downloads";
import type { Settings } from "./settings";

/**
 * A log as an agent reads it (MCP's comfy_log, boot_log): never a secret, never a folder on a disk. ComfyUI and a pod print
 * what they were given (a download's address with its token, an environment with the lock's token, a traceback through the
 * user's folders), and what reaches an agent may reach its maker's servers. Two passes: every secret Afflatus keeps, by its
 * value wherever it shows (a token printed bare, inside an address, cut into a line); then what looks like one by its shape
 * (a key=value of a secret's name, a Bearer, an address's token, the known prefixes of keys). Paths last, each made its
 * file's name, as a download's error is (downloads.ts withoutPaths).
 */

/** What a secret is replaced with. */
export const HIDDEN = "[hidden]";

/** A value too short to be a secret of its own: a word of the log that happens to be a setting's value would be hidden everywhere. */
const SHORTEST = 8;

/** Every secret the settings hold, by value: the sites' keys, Telegram's and Discord's, the LLMs' keys and each machine's lock token. */
export function secretsOf(settings: Settings): string[] {
  const all = [
    settings.civitaiKey, settings.huggingFaceToken, settings.runpodKey, settings.runpodS3User, settings.runpodS3Secret,
    settings.notify.telegramToken, settings.notify.discordWebhook,
    ...settings.llms.map((l) => l.apiKey),
    ...settings.machines.map((m) => m.token),
  ];
  // the longest first: one secret inside another is hidden whole
  return [...new Set(all.map((v) => v.trim()).filter((v) => v.length >= SHORTEST))].sort((a, b) => b.length - a.length);
}

/**
 * What a secret looks like, whoever it is from. `$1` is kept: the name it is given, so that the line still says what was
 * there. Names that end in a secret's word (`AFFLATUS_LOCK_TOKEN=`, `"api_key": `), not those that only start with one
 * (`tokenizer:` stays).
 */
const SHAPES: Array<[RegExp, string]> = [
  // Afflatus's own MCP tokens, Hugging Face's, RunPod's
  [/\bafl_mcp_[\w-]+/g, HIDDEN],
  [/\bhf_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\brpa_[A-Za-z0-9]{20,}/g, HIDDEN],
  // a Telegram bot's token, a Discord webhook's address
  [/\b\d{6,}:[\w-]{30,}/g, HIDDEN],
  [/(https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/)\S+/gi, `$1${HIDDEN}`],
  // a header's credentials
  [/(\b(?:Bearer|Basic|Token)\s+)[\w.~+/=-]{8,}/gi, `$1${HIDDEN}`],
  // an address's query: a token, a key, a signature (a presigned S3 link's)
  [/([?&](?:token|access_token|api_?key|key|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|password)=)[^&\s"'<>]+/gi, `$1${HIDDEN}`],
  // a user and password in an address
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${HIDDEN}@`],
  // name = value, name: value, "name": "value"
  [/(\b[\w.-]*?(?:token|api[_-]?key|access[_-]?key|secret|password|passwd)["']?\s*[:=]\s*["']?)(?!\[hidden\])[^\s"',;&]+/gi, `$1${HIDDEN}`],
];

/** A line of a log without the secrets in `secrets`, nor what looks like one, nor a folder on a disk. */
export function scrubbed(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of secrets) out = out.split(v).join(HIDDEN);
  for (const [shape, by] of SHAPES) out = out.replace(shape, by);
  return withoutPaths(out);
}
