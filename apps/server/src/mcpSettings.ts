import { SETTING_HELP, settingHelp } from "@afflatus/core";
import { z } from "zod";
import { httpError } from "./errors";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { onThisMachine } from "./modelDownload";
import type { Services } from "./services";
import { publicSettings, readSettings, settingsSchema, type Settings } from "./settings";
import { saveSettings } from "./setup-api";

/**
 * The settings, from outside (MCP): read and changed as the Settings page does, generated from the settings' own zod
 * schema (each one's shape and range as JSON Schema) with its "?" text (core settingsHelp.ts, the page's own), and saved
 * through the page's save (setup-api.ts saveSettings: the same validation, the same refusals, the same follow-ups).
 *
 * Every setting of the schema is one of four kinds, and a setting added later that is none of them fails a test
 * (mcpSettings.test.ts) before it ships unsaid:
 * - one an agent may change (Manage): those with a "?" text in SETTING_HELP;
 * - one on the never-list (mcpTool.ts NEVER): the Sign-in settings, where notices and reset codes go, Afflatus's updates.
 *   Not read either;
 * - a secret (API keys, tokens): never read back (said set or not), and never written from here either. A key pasted
 *   into a chat would sit in the agent's transcript, and one swapped for another account's would move the user's bills
 *   or downloads elsewhere: the user pastes keys in Afflatus itself;
 * - one kept elsewhere: read here, changed through its own tool or in Afflatus itself (the machines, a folder on this
 *   computer, the licences the user accepted, what the app keeps for itself).
 */

/** The never-list's subject of a setting, by its dotted path: its first part, and Telegram's and Discord's own under notify. */
function neverOf(path: string): string | null {
  const [top, sub, kind] = path.split(".");
  if (top === "access") return "access";
  if (top === "afflatusUpdateChecks") return "updates";
  if (top === "notify" && (sub === "telegramToken" || sub === "telegramChat" || sub === "discordWebhook" || (sub === "events" && kind === "newDevice"))) return "notify-channels";
  return null;
}

/** The secrets: never read back, never written from here. */
const SECRETS: Record<string, string> = {
  civitaiKey: "Civitai's API key",
  huggingFaceToken: "the Hugging Face token",
  runpodKey: "the RunPod API key",
  runpodS3User: "RunPod's S3 API key",
  runpodS3Secret: "RunPod's S3 API key",
};

/**
 * The settings kept elsewhere: read here (unless `hidden`), changed where it says. `path`: folders on a disk, said set or
 * not, never read (where the user keeps things on this computer is not an agent's to know).
 */
export const ELSEWHERE: Record<string, { where: string; hidden?: true; path?: true }> = {
  machines: { where: "list_machines, edit_machine and remove_machine; a machine is added, and its address changed, in Afflatus itself" },
  comfyUrl: { where: "Settings › ComfyUI in Afflatus itself (the first machine's address)" },
  comfyDir: { where: "Settings › ComfyUI in Afflatus itself: a folder on this computer", path: true },
  llms: { where: "Settings › Prompts in Afflatus itself: an LLM's address goes with its API key" },
  firstLaunch: { where: "the app itself (the first launch's page)", hidden: true },
  lastDeploy: { where: "deploy_pod (the last deploy's choices are its defaults)" },
  acceptedPresets: { where: "Afflatus itself: a licence is accepted by the user's own tick" },
  downloadPlaces: { where: "Settings › Models › Downloads in Afflatus itself: folders on a disk", path: true },
  leftSecrets: { where: "the server's own", hidden: true },
  pendingDeploys: { where: "the server's own", hidden: true },
};

/** The settings an agent may change: the top keys of SETTING_HELP's paths. */
const WRITABLE = new Set(Object.keys(SETTING_HELP).map((k) => k.split(".")[0]!));

type Kind = "writable" | "never" | "secret" | "elsewhere";

/** What kind a setting of the schema is (its first part); null for one that is none, which the coverage test refuses. */
export function kindOf(top: string): Kind | null {
  if (neverOf(top)) return "never";
  if (top in SECRETS) return "secret";
  if (WRITABLE.has(top)) return "writable";
  if (top in ELSEWHERE) return "elsewhere";
  return null;
}

/** A setting's shape and range, from the schema itself (zod's JSON Schema of its input). */
function schemaOf(top: string): unknown {
  const field = (settingsSchema.shape as Record<string, z.ZodType>)[top];
  if (!field) return undefined;
  const json = z.toJSONSchema(field, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Notify as an agent reads it: its picture and its kinds, without where they go (never-list) nor the new-device notice. */
function notifyRead(n: Settings["notify"]) {
  const { newDevice: _newDevice, ...events } = n.events;
  return { picture: n.picture, events };
}

/** Every setting an agent may read, by key: its value as the page is given it (secrets said set or not), and its kind. */
async function readable(s: Services): Promise<Array<{ key: string; value: unknown; kind: Kind }>> {
  const settings = await readSettings(s.db);
  const pub = publicSettings(settings, onThisMachine) as Record<string, unknown>;
  const out: Array<{ key: string; value: unknown; kind: Kind }> = [];
  for (const key of Object.keys(settingsSchema.shape)) {
    const kind = kindOf(key);
    if (!kind || kind === "never") continue;
    if (kind === "secret") {
      out.push({ key, value: { set: Boolean((settings as Record<string, unknown>)[key]) }, kind });
      continue;
    }
    if (kind === "elsewhere" && ELSEWHERE[key]!.hidden) continue;
    if (kind === "elsewhere" && ELSEWHERE[key]!.path) {
      const v = (settings as Record<string, unknown>)[key];
      out.push({ key, value: { set: typeof v === "string" ? Boolean(v.trim()) : Boolean(v && Object.keys(v).length) }, kind });
      continue;
    }
    // the machines as list_machines says them, without their tokens and folders
    if (key === "machines") {
      out.push({ key, value: settings.machines.map((m) => ({ id: m.id, name: m.name, kind: m.rented ? "rented pod" : "ComfyUI" })), kind });
      continue;
    }
    out.push({ key, value: key === "notify" ? notifyRead(settings.notify) : pub[key], kind });
  }
  return out;
}

const readSettingsTool = tool({
  name: "read_settings",
  scope: "look",
  title: "Settings",
  description: "Afflatus's settings as Settings shows them, each with its value, its \"?\" text, and whether it may be changed here (change_setting, Manage) or where it is changed. A secret (an API key, a token) is said set or not, never read back. The Sign-in settings, where notices and reset codes go and Afflatus's updates are never reached through MCP. `key`: one setting (a dotted path reaches inside: \"rentCaps.day\"), with its shape and range as JSON Schema.",
  input: {
    key: z.string().min(1).max(200).optional().describe("One setting, or a dotted path inside one (\"finish.route\")."),
  },
  touches: (a) => (a.key ? [neverOf(a.key) ?? ""] : []),
  async run({ key }, ctx) {
    const all = await readable(ctx.s);
    if (!key) {
      ctx.said(`Read the settings: ${all.length}`);
      return {
        settings: all.map((x) => ({
          key: x.key, value: x.value,
          ...(x.kind === "writable" ? { help: settingHelp(x.key) } : {}),
          changed: x.kind === "writable" ? "change_setting" : x.kind === "secret" ? "in Afflatus itself (a secret)" : ELSEWHERE[x.key]!.where,
        })),
        never: "The Sign-in settings, where notices and reset codes go (Telegram, Discord, the new-device notice) and Afflatus's updates: never through MCP.",
      };
    }
    const [top, ...rest] = key.split(".");
    const found = all.find((x) => x.key === top);
    if (!found) throw httpError(`There is no setting called ${top} that an agent may read: read_settings without a key lists them.`, 404);
    let value: unknown = found.value;
    for (const part of rest) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    ctx.said(`Read the setting ${quoted(key)}`);
    return {
      key, value,
      ...(found.kind === "writable" ? { help: settingHelp(key), schema: schemaOf(top!) } : {}),
      changed: found.kind === "writable" ? "change_setting" : found.kind === "secret" ? "in Afflatus itself (a secret)" : ELSEWHERE[top!]!.where,
    };
  },
});

/** The value at a dotted path of a setting, set (null on a record's key: that key taken out). */
function setAt(whole: unknown, path: readonly string[], value: unknown): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const base = whole && typeof whole === "object" && !Array.isArray(whole) ? { ...(whole as Record<string, unknown>) } : {};
  const next = setAt(base[head!], rest, value);
  if (next === null && !rest.length) delete base[head!];
  else base[head!] = next;
  return base;
}

/** Whether a value sent for notify (whole, or its events) names where notices go or the new-device notice. */
function namesChannels(path: readonly string[], value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (path.length === 1) return ["telegramToken", "telegramChat", "discordWebhook"].some((k) => k in v) || namesChannels(["notify", "events"], v.events);
  if (path.length === 2 && path[1] === "events") return "newDevice" in v;
  return false;
}

/**
 * Refused without Spend when the app's rented-GPU caps would be raised or taken off (0 is none): lowering one, or setting
 * one where there was none, is Manage's; letting more be spent is Spend's (a money path). Read off what would be sent,
 * whichever path was asked ("rentCaps", "rentCaps.day"); a value the schema refuses is left to the save to refuse.
 */
function mayRaiseCaps(ctx: ToolCtx, was: Settings["rentCaps"], sent: unknown): void {
  if (ctx.token.scopes.includes("spend")) return;
  const next = (sent && typeof sent === "object" ? sent : {}) as Record<string, unknown>;
  for (const k of ["day", "month"] as const) {
    const now = next[k] === undefined ? was[k] : next[k];
    if (typeof now !== "number") continue;
    const raised = was[k] > 0 && (now <= 0 || now > was[k]);
    if (raised) throw refusal(`This token cannot spend on rented GPUs, and ${now <= 0 ? "taking off" : "raising"} the app's ${k === "day" ? "daily" : "monthly"} cap lets more be spent on them: tick Spend on it in Settings › Agents (MCP), or the user changes it in Settings › Costs. Lowering a cap needs Manage only.`);
  }
}

const changeSetting = tool({
  name: "change_setting",
  scope: "manage",
  title: "Change a setting",
  description: "Change one setting of Afflatus as Settings does, with the same checks and the same save: a dotted path reaches inside one (\"rentCaps.month\", \"finish.route\", \"families.flux\"; null on a family's or a file's key takes it out). read_settings says which may be changed here, each with its \"?\" text and range. Secrets, the Sign-in settings, where notices and reset codes go and Afflatus's updates are refused. Raising or taking off the app's rented-GPU caps (rentCaps) needs Spend too; lowering them is Manage's. Answers the value it had and the one it has now.",
  input: {
    key: z.string().min(1).max(200).describe("The setting, or a dotted path inside it."),
    value: z.unknown().describe("Its new value, as read_settings shows values (its schema with key)."),
  },
  touches: (a) => [neverOf(a.key) ?? ""],
  async run({ key, value }, ctx) {
    const { s } = ctx;
    const path = key.split(".");
    const top = path[0]!;
    if (top === "notify" && namesChannels(path, value)) ctx.never("notify-channels");
    const kind = kindOf(top);
    if (kind === "secret") throw refusal(`${SECRETS[top]} is a secret: it is pasted in Afflatus itself (Settings), never through MCP.`);
    if (kind !== "writable") throw httpError(kind === "elsewhere" ? `${top} is changed through ${ELSEWHERE[top]!.where}.` : `There is no setting called ${top}: read_settings lists them.`, kind ? 400 : 404);
    // notify is sent as the page sends it, only what changed (merged on the server, settings.ts notifyMerged): sent whole it
    // would carry where notices go, which is never this token's to say
    if (top === "notify" && !(path[1] === "picture" || path[1] === "events")) throw httpError("Of the notices, only notify.picture and notify.events.<kind> are changed here.");
    const settings = await readSettings(s.db);
    const was = path.reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), settings);
    const sent = top === "notify" ? setAt({}, path.slice(1), value) : setAt((settings as Record<string, unknown>)[top], path.slice(1), value);
    if (top === "rentCaps") mayRaiseCaps(ctx, settings.rentCaps, sent);
    await saveSettings(s, { [top]: sent }, { session: null, password: undefined, ip: ctx.ip });
    const now = path.reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), await readSettings(s.db));
    ctx.said(`Changed the setting ${quoted(key)}: ${JSON.stringify(was) ?? "none"} → ${JSON.stringify(now) ?? "none"}`.slice(0, 300));
    return { key, was: was ?? null, now: now ?? null };
  },
});

export const SETTING_TOOLS = [readSettingsTool, changeSetting];
