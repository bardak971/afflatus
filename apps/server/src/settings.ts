import { z } from "zod";
import { presetFileSchema } from "@afflatus/core";
import { envSaid } from "./config";
import type { Db } from "./db";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";

/** An address the server will talk to: http or https, nothing else (no file:, no ftp:). */
const httpUrl = z.url({ protocol: /^https?$/ });

/** One language model the designer can write with: any OpenAI-compatible endpoint. */
export const llmSchema = z.object({
  id: z.string().min(1).max(40),
  /** What the user calls it, for the list ("Local Qwen"). Empty: the model's own name is shown. */
  name: z.string().max(60).default(""),
  /** The endpoint's address (an http or https URL), or empty for a model not yet set up. */
  baseUrl: httpUrl.or(z.literal("")).default(""), model: z.string().default(""), apiKey: z.string().default(""),
  /** The model can read pictures: the designer is shown the picture a form opens on. */
  vision: z.boolean().default(false),
  /** How much the model can read at once, in tokens: the conversation is cut to what fits, oldest first. */
  contextSize: z.number().int().min(2048).max(2_000_000).default(16384),
  /** The longest answer it may write, in tokens. A model that thinks before it answers spends these on thinking too. */
  maxOutputTokens: z.number().int().min(256).max(65536).default(3000),
  /** Ask the model not to think before it answers (enable_thinking=false for llama.cpp, vLLM and SGLang; think=false for Ollama). A server that rejects fields it does not know answers with an error: then off. */
  noThinking: z.boolean().default(false),
});
export type Llm = z.infer<typeof llmSchema>;

/** Instructions of the user's own for the designer, under a name: a way of writing to pick per conversation. */
const instructionSchema = z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), text: z.string().max(8000).default("") });

/** Everything the setup page edits. Stored as one JSON value per key. */
const finishSchema = z.object({
  /** SeedVR2 (restores + enlarges, any clip), H3's latent re-sample (H3 clips; others take SeedVR2), RTX VSR, a pixel upscale model. */
  route: z.enum(["seedvr", "latent", "rtx", "model"]).default("seedvr"),
  factor: z.number().min(1).max(4).default(2),
  colour: z.enum(["lab", "wavelet", "adain", "none"]).default("lab"),
  /** The pixel route's model file; empty = the first found. */
  upscaleModel: z.string().max(200).default(""),
  latentDenoise: z.number().min(0.05).max(0.6).default(0.15),
  latentSteps: z.number().int().min(1).max(6).default(2),
  /** SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames: z.number().int().min(0).max(49).default(0),
  /** RCAS after a pixel route (SeedVR2, RTX, a model), 0 to 1; 0 = off. */
  sharpen: z.number().min(0).max(1).default(0),
});

/** The command bar (docs/command-bar.md): its shortcut, and its optional parts, each off until turned on. */
const barSchema = z.object({
  /** Written as the keys are named: "Ctrl+K", "Ctrl+Shift+P", "Alt+Space". */
  shortcut: z.string().trim().regex(/^(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}(?:[A-Za-z0-9]{1,12}|[^\sA-Za-z0-9+])$/, "a shortcut is written like Ctrl+K or Alt+Space").default("Ctrl+K"),
  /** Prompt snippets: `;name` in a prompt field expands to the Prompt kit snippet of that name. */
  snippets: z.boolean().default(false),
  /** Cast: `@` in the bar adds a person of the Prompt kit. */
  cast: z.boolean().default(false),
});

/**
 * One ComfyUI the queue sends work to: a GPU of this computer (one ComfyUI per GPU, `--cuda-device N`), another computer,
 * or a rented instance. `id` stays when the address changes, so that what was learned of it (its speed, what it holds) stays.
 */
/**
 * A machine that is a rented pod (rented.ts): the provider and the pod's id there, and what happens when it sits idle. Its
 * address (`url`) is the pod's ComfyUI, worked out when it was added. Afflatus never starts one on its own.
 */
export const rentedSchema = z.object({
  provider: z.literal("runpod"),
  pod: z.string().min(1).max(80),
  /** Minutes with nothing rendering there and nothing waiting that it could take, then `idleDo`; 0: never. */
  idleMinutes: z.number().int().min(0).max(24 * 60).default(10),
  /** stop: the GPU stops billing, its disk goes on; terminate: the pod is deleted on the provider, nothing billed. */
  idleDo: z.enum(["stop", "terminate"]).default("stop"),
  /** Minutes this PC may be silent before the pod stops itself (the node pack's watchdog); 0: no watchdog. */
  watchdogMinutes: z.number().int().min(0).max(24 * 60).default(15),
  /**
   * Its other public ports (a template's FileBrowser, JupyterLab, SSH) kept open at its start. Off: closed at each Start, only
   * ComfyUI's (locked) reached: those others have their own logins, some with a default password printed in the template.
   */
  openPorts: z.boolean().default(false),
  /** The ports Afflatus closed on it ("8080/http"): put back at a Start once they are to be kept open. */
  closedPorts: z.array(z.string().max(40)).max(20).default([]),
  /** The RunPod secret its token is kept in, when Afflatus named it (a deployed pod's); empty: "afflatus-<pod>" (tokenSecret). */
  secret: z.string().max(80).default(""),
  /** Deployed from Afflatus (its image is pulled at its first start, which may take long): not a pod added as it was. */
  deployed: z.boolean().default(false),
  /**
   * When it was deployed (ISO), until its ComfyUI first answered: its boot limit counts from then, whatever RunPod says
   * meanwhile (an image that never pulls keeps a pod provisioning, billed). Emptied once it answered.
   */
  deployedAt: z.string().max(40).default(""),
  /** The user stopped it (their Stop), until it is started again: kept across a restart of Afflatus, so that a pod the user
   *  stopped is never taken for one its watchdog stopped (a deployed one that keeps nothing is then terminated). */
  userStopped: z.boolean().default(false),
  /** The network volume it was deployed on, by id ("" for none): it holds that volume while it runs. */
  volume: z.string().max(80).default(""),
  /** Deployed only to fill its volume (Fill from a set…): it takes no render, and is terminated once its files are in. */
  fill: z.boolean().default(false),
  /**
   * The image it was deployed with, when Afflatus deployed it ("ghcr.io/…/afflatus-pod:0.1.25"): an image that reports its
   * ComfyUI's death (runpod.ts reportsDeath) is not taken for crashed when a render is merely gone from it.
   */
  image: z.string().max(300).default(""),
  /** RunPod's cloud it was deployed on, when Afflatus deployed it: the speeds its files came at are kept per cloud (podMeasures.ts). */
  cloud: z.enum(["SECURE", "COMMUNITY"]).optional(),
  /** The files its deploy asked for, handed to it at its first answer (podFiles.ts), then emptied. */
  files: z.array(presetFileSchema).max(300).default([]),
  /** The files its deploy left out (unticked): its jobs that use one stay elsewhere. Handed at its first answer, then emptied. */
  leaveOut: z.array(z.strictObject({ file: z.string().max(400), folder: z.string().max(120) })).max(300).default([]),
  /**
   * Make room: when a file its jobs need does not fit on its disk, the models Afflatus fetched there that no waiting job needs
   * are deleted first, the longest unused first (podFiles.ts). Never a file Afflatus did not fetch. Off: such a job goes elsewhere.
   */
  makeRoom: z.boolean().default(false),
});

/** What a GPU is deployed with (Settings › Rented GPUs › Deploy a GPU): the dialog's choices. */
export const deploySchema = z.object({
  /** RunPod's id of the GPU ("NVIDIA A40"). */
  gpu: z.string().min(1).max(120),
  cloud: z.enum(["SECURE", "COMMUNITY"]).default("SECURE"),
  /** afflatus: ComfyUI with the node pack, locked from its first second; runpod: RunPod's own ComfyUI image (runpod.ts POD_IMAGES). */
  template: z.enum(["afflatus", "runpod"]).default("afflatus"),
  /** A network volume's id (the models kept between deploys; the pod then runs in its data center); empty: none. */
  volume: z.string().max(80).default(""),
  /** Its container disk, GB: the models when there is no volume. */
  disk: z.number().int().min(20).max(2000).default(120),
  idleMinutes: z.number().int().min(0).max(24 * 60).default(10),
  idleDo: z.enum(["stop", "terminate"]).default("terminate"),
  watchdogMinutes: z.number().int().min(0).max(24 * 60).default(15),
  /** The Model set picked (its id), remembered for the next deploy; empty: none. */
  set: z.string().max(80).default(""),
  /** The model files ticked: fetched onto the pod once it is up, after what its jobs wait for. Not remembered. */
  files: z.array(presetFileSchema).max(300).default([]),
  /** The waiting jobs' files unticked: those jobs stay elsewhere. Not remembered. */
  leaveOut: z.array(z.strictObject({ file: z.string().max(400), folder: z.string().max(120) })).max(300).default([]),
  /** Make room on its disk by deleting the models it fetched that no waiting job needs (rentedSchema.makeRoom). */
  makeRoom: z.boolean().default(true),
  /** The presets whose licence was accepted in the dialog, by id. Not remembered. */
  accept: z.array(z.string().max(120)).max(40).default([]),
  /** Deploy again: nothing was ticked, the remembered set's files come (deployModels.ts deployFiles). Not remembered. */
  again: z.boolean().default(false),
  /**
   * The Afflatus image's CUDA build (core CudaPick): 13.0 only by default, 12.8, or either (13.0 first). Remembered; the
   * Hunt takes it too.
   */
  cuda: z.enum(["13.0", "12.8", "either"]).default("13.0"),
  /** This deploy alone on 12.8, as the dialog asked when no CUDA 13 host was free: the remembered pick stays as it was. */
  cudaOnce: z.boolean().default(false),
});
export type DeployAsk = z.infer<typeof deploySchema>;


/**
 * What Afflatus tells about, on Telegram, Discord and in the browser (notify.ts); `gpuFound` and `huntGaveUp` are the GPU
 * hunt's (hunt.ts), `newDevice` the password's (access.ts): a sign-in from a device never seen before.
 */
export const NOTIFY_KINDS = ["renderDone", "renderFailed", "queueEmpty", "renderStuck", "podStopped", "capReached", "balanceLow", "comfyGone", "gpuFound", "huntGaveUp", "newDevice"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
/**
 * Only a render done is off by default: every other kind is something to act on. A new device goes to Telegram only: a
 * Discord channel is often shared, and who signs in where is the owner's to read.
 */
const channels = (telegram: boolean, discord = telegram) => z.object({ telegram: z.boolean().default(telegram), discord: z.boolean().default(discord) }).prefault({});
const notifySchema = z.object({
  /** The bot's token (@BotFather): a secret, never given to the page, never in a log nor a message. */
  telegramToken: z.string().trim().max(200).default(""),
  /** The chat the bot writes to: a user's or a group's id, or a channel's @name. */
  telegramChat: z.string().trim().max(80).default(""),
  /** A Discord webhook's address: a secret too (anyone who has it can write to the channel). */
  discordWebhook: z.string().trim().max(400).default(""),
  /** A small picture of what a render made goes with its message. */
  picture: z.boolean().default(true),
  /** Per kind, the channels it is sent to (the browser's ticks are kept per browser). */
  events: z.object(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, k === "newDevice" ? channels(true, false) : channels(k !== "renderDone")])) as Record<NotifyKind, ReturnType<typeof channels>>).prefault({}),
});
export type NotifySettings = z.infer<typeof notifySchema>;

/** The password as stored (access.ts hashPassword): scrypt's figures, the salt and the hash, and when it was set. Never sent to the page. */
const passwordSchema = z.object({ hash: z.string().max(400), setAt: z.string().max(40) });

/** The optional password (Settings › Interface › Access, access.ts). */
const accessSchema = z.object({
  /** Null: no password, Afflatus is open to whoever reaches it, as before there was one. */
  password: passwordSchema.nullable().default(null),
  /**
   * A request from this computer itself (hostCheck.ts fromThisComputer) needs no password. Off by default, and never in
   * effect while Afflatus listens on loopback only (access.ts bypassOn): anyone else then comes through a forwarder on
   * this computer, which looks like it.
   */
  localNoPassword: z.boolean().default(false),
  /** How long a device that ticked "Remember" stays signed in. */
  stayDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30),
  /** Reset codes may go to Telegram (when it is set in Notifications); the console and the log file always have them. */
  resetTelegram: z.boolean().default(true),
  /** The SHA-256 of the token Prometheus sends for /metrics while a password is set (access.ts metricsToken); empty: none. */
  metricsToken: z.string().max(100).default(""),
  /** When Telegram's bot or chat last changed (ISO): no reset code goes there for 24 h after (access.ts telegramChanged). */
  telegramChangedAt: z.string().max(40).default(""),
});
export type AccessSettings = z.infer<typeof accessSchema>;

export const machineSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/, "a machine id is lower-case letters, digits and dashes"),
  /** What the user calls it ("Studio PC", "Second GPU"); empty: its address is shown. */
  name: z.string().trim().max(40).default(""),
  url: httpUrl,
  /** Its ComfyUI folder on this computer, when they share a disk (the node pack is written there); empty otherwise. */
  dir: z.string().max(400).default(""),
  /** What the queue gives it: everything, pictures only or videos only (a clip, a sound, a finish). */
  takes: z.enum(["all", "image", "video"]).default("all"),
  /**
   * A node pack a render asks for that its ComfyUI lacks (jobPacks.ts): "ask", the job waits and its Queue row offers
   * Install and restart; "always", installed through ComfyUI-Manager without asking. ComfyUI restarts only once nothing
   * renders on it. A rented pod installs what its jobs need whatever this says (podPacks.ts).
   */
  packs: z.enum(["ask", "always"]).default("ask"),
  /**
   * Model families switched on or off on this machine by hand, by family id, over the switch of every machine (`families`
   * below): off, the queue sends it nothing of that family. One not named follows that switch, then its files there.
   */
  families: z.record(z.string().max(120), z.boolean()).default({}),
  /**
   * Its token when its ComfyUI is locked (Afflatus's node pack, lock.py): sent on every call to it. A secret: never given
   * to the page (it is told the last four characters), never in a log. Empty: not locked, or locked by another Afflatus.
   */
  token: z.string().max(200).default(""),
  /** A rented pod (rentedSchema); absent for a ComfyUI of its own. */
  rented: rentedSchema.optional(),
});
export type Machine = z.infer<typeof machineSchema>;

/** The id the first ComfyUI has had since before there could be several: what it learned is filed under it. */
export const FIRST_MACHINE = "m1";

/** How many ComfyUIs Afflatus keeps at most (its own and rented). */
export const MAX_MACHINES = 12;

export const settingsSchema = z.object({
  /**
   * The ComfyUIs, the first one first: it is the one the setup, the downloads, the node packs and "open in ComfyUI" talk
   * to. `comfyUrl` and `comfyDir` below are the first one's address and folder, kept in step with it (older callers read them).
   */
  machines: z.array(machineSchema).max(MAX_MACHINES).default([]),
  comfyUrl: httpUrl.default("http://127.0.0.1:8188"),
  /**
   * ComfyUI's own folder on the computer Afflatus runs on (the one with main.py), when they share a disk.
   * Lets Afflatus put a workflow where ComfyUI's page opens it straight away. Empty when ComfyUI is elsewhere.
   */
  comfyDir: z.string().max(400).default(""),
  /** ComfyUI's models are unloaded after this many minutes without a render. 0: never, they stay until something else needs the room. */
  unloadAfterMinutes: z.number().min(0).max(24 * 60).default(0),
  /** The language models of the prompt designer. None = the designer is off. */
  llms: z.array(llmSchema).max(12).default([]),
  /** The one the designer writes with (an id of `llms`); the first when it names none. */
  designerLlm: z.string().default(""),
  designerInstructions: z.array(instructionSchema).max(30).default([]),
  /** The instructions in use (an id of `designerInstructions`); empty for none. */
  designerInstruction: z.string().default(""),
  /** The user's own prompting guide for a model family (family id → text), in place of the built-in one; empty = the built-in. */
  designerGuides: z.record(z.string().max(120), z.string().max(12000)).default({}),
  /** Tags written for an anime model are compared with danbooru's list, under the prompt and in what the designer writes. */
  tagCheck: z.boolean().default(true),
  /**
   * Model families switched on or off by hand, by family id. One that is not named follows its files:
   * offered when they are found on ComfyUI, left out when they are not. Off only takes it out of the
   * lists to choose from: what was made with it, and drafts that use it, stay as they are.
   */
  families: z.record(z.string().max(120), z.boolean()).default({}),
  /**
   * A family not named in `families` is on whatever files are found: the switch says "I want it", and its files are listed
   * greyed until they are there (fetched by a pod, downloaded into a ComfyUI of the user's own). New installs start with
   * it (seedNewInstall); an existing one keeps the rule it had, its families following their files, until Settings › Models'
   * "Turn them all on" sets it.
   */
  allFamilies: z.boolean().default(false),
  /**
   * The first launch's page (where you render): "pending" on a new install until it is done or skipped, then "done" for good.
   * An install from before it existed reads "done": it already says where it renders.
   */
  firstLaunch: z.enum(["pending", "done"]).default("done"),
  civitaiKey: z.string().default(""),
  /** A Hugging Face access token: gated models (Flux dev…) need one whose account accepted their terms. A secret, never given to the page. */
  huggingFaceToken: z.string().default(""),
  /** The RunPod API key, for rented machines (runpod.ts): a secret, never given to the page. */
  runpodKey: z.string().default(""),
  /**
   * RunPod's S3 API key (RunPod â€º Settings â€º S3 API Keys), for the volume viewer (runpodS3.ts): its access key, the RunPod
   * user's id, shown; and its secret, never given to the page. Not the API key above.
   */
  runpodS3User: z.string().trim().max(120).default(""),
  runpodS3Secret: z.string().trim().max(200).default(""),
  /** What the rented GPUs may cost, in USD, today and this month (rented.ts); 0: no cap. At a cap the running render ends, then they stop. */
  rentCaps: z.object({ day: z.number().min(0).max(100_000).default(0), month: z.number().min(0).max(1_000_000).default(0) }).default({ day: 0, month: 0 }),
  /**
   * What this PC's electricity costs, for the Costs tab's "This PC" (its renders' GPU energy × the price): a kWh's price in
   * the user's own money (null: not said, the energy alone is shown) and the symbol it is written with.
   */
  costs: z.object({ kwhPrice: z.number().min(0).max(100).nullable().default(null), currency: z.string().trim().min(1).max(4).default("€") }).default({ kwhPrice: null, currency: "€" }),
  /** The last deploy's choices: the Deploy dialog opens with them, and "Deploy again" repeats them. Null before the first. */
  lastDeploy: deploySchema.nullable().default(null),
  /** A network volume no pod ran on for this many days is flagged (it bills every month all the same); 0: never. */
  volumeUnusedDays: z.number().int().min(0).max(365).default(7),
  /**
   * A deployed pod's boot log (RunPod's system log of its pull, and the pod's own boot log) is kept with its run for this
   * many days, for Queue › Costs; 0: none is kept, and those kept go. Its pull's figures are kept either way.
   */
  bootLogDays: z.number().int().min(0).max(365).default(0),
  /**
   * The RunPod secrets of pods removed from Afflatus while they still were on RunPod: each pod reads its own at its start,
   * so it stays as long as the pod does, and is deleted once the pod is gone (rented.ts). Never given to the page.
   */
  leftSecrets: z.array(z.object({ secret: z.string().max(80), pod: z.string().max(80) })).max(500).default([]),
  /**
   * The deploys asked of RunPod whose machine is not saved yet (rented.ts): each pod's name, kept before RunPod is asked to
   * make it, and its secret. A name still here while no deploy runs is a pod Afflatus may have made and does not follow (it
   * stopped mid-deploy, or RunPod's answer was lost and its list showed the pod late): terminated once RunPod lists it,
   * forgotten when it never does. Never given to the page.
   */
  pendingDeploys: z.array(z.object({ name: z.string().max(120), secret: z.string().max(80), at: z.string().max(40) })).max(50).default([]),
  /** Missing model files may be looked for on Civitai. Off: Afflatus never contacts Civitai. */
  civitaiLookups: z.boolean().default(false),
  /** Once a day, Civitai is asked whether it has newer versions of the models here (only with lookups on; hashes of the files are sent). */
  updateChecks: z.boolean().default(false),
  /** Once a day, GitHub is asked whether a newer Afflatus is out (updates.ts); nothing about the user is sent. Apart from `updateChecks`, which is about the models. */
  afflatusUpdateChecks: z.boolean().default(true),
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. Off: Afflatus never asks ComfyUI to download anything. */
  downloadModels: z.boolean().default(false),
  /**
   * How many days the time of each render is kept one by one. Older ones are folded into figures per
   * model and day, which stay for good. 0: each one is kept for good.
   */
  renderHistoryDays: z.number().int().min(0).max(3650).default(90),
  /** How many days a result nobody kept has before it goes to the bin by itself (sweep.ts); 0: it never goes on its own. */
  unkeptDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]).default(1),
  /** How many days what is in the bin is kept before it is erased, file and all (sweep.ts); 0: until the bin is emptied by hand. */
  binDays: z.union([z.literal(0), z.literal(7), z.literal(30)]).default(7),
  /** How "Finish all clips" brings a timeline to its final quality: the user's defaults, each run can differ. */
  finish: finishSchema.prefault({}),
  /** A family's file chosen by hand where several fit (family id → slot id → file name); a slot not named follows its patterns. */
  slotFiles: z.record(z.string().max(120), z.record(z.string().max(80), z.string().max(400))).default({}),
  /** The presets whose files' licence was accepted (by preset id): fetched without asking again. */
  acceptedPresets: z.array(z.string().max(120)).max(500).default([]),
  /** The command bar's shortcut and its optional parts. */
  bar: barSchema.prefault({}),
  /**
   * The projects pinned to the rail under the one worked in, in their order there (project ids, four at most): one click
   * switches to each. A project deleted or archived is taken out (projects.ts).
   */
  pinnedProjects: z.array(z.string().min(1).max(80)).max(4).refine((ids) => new Set(ids).size === ids.length, "a project is pinned once").default([]),
  /** Where Afflatus's notices go (Telegram, Discord) and which kinds go there (notify.ts). */
  notify: notifySchema.prefault({}),
  /** The optional password and how it behaves (access.ts). */
  access: accessSchema.prefault({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** The language model the designer writes with. */
export const llmInUse = (s: Settings): Llm | undefined => s.llms.find((l) => l.id === s.designerLlm) ?? s.llms[0];
/** The user's own instructions in use, when there are some. */
export const instructionsInUse = (s: Settings): string => s.designerInstructions.find((i) => i.id === s.designerInstruction)?.text.trim() ?? "";

/**
 * The settings as last read, per database: they are asked for on every request that touches ComfyUI
 * and on every tick of the event stream, and the table only changes through writeSettings, which
 * forgets this. (The queue writes its own notes into the same table under keys the schema ignores.)
 */
const cached = new WeakMap<Db, Promise<Settings>>();

export function readSettings(db: Db): Promise<Settings> {
  let value = cached.get(db);
  if (!value) {
    value = load(db);
    cached.set(db, value);
    // a read that failed is not kept: the next one tries again
    value.catch(() => cached.delete(db));
  }
  return value;
}

async function load(db: Db): Promise<Settings> {
  const rows = await db.selectFrom("settings").select(["key", "value"]).execute();
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value);
    } catch {
      // a value that isn't JSON falls back to its default
    }
  }
  // before there was a list, there was one model under "llm": it is the first of the list
  const { llm: one, ...rest } = raw;
  if (rest.llms === undefined && one && typeof one === "object" && (one as { baseUrl?: string }).baseUrl) rest.llms = [{ id: "main", ...one }];
  // a list of machines never written is an install from before there could be several (or none): its ComfyUI is the first
  // machine. One written, even empty (a new install's, seedNewInstall; every machine removed), is the list as it is
  const listed = Array.isArray(rest.machines);
  const parsed = settingsSchema.safeParse(rest);
  if (parsed.success) return inStep(parsed.data, listed);
  // a stored value the schema no longer takes (an address without its scheme, say) falls back to its default rather than locking every setting
  const broken = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
  console.warn(`[settings] stored values that are no longer valid were set aside: ${[...broken].join(", ")}`);
  for (const key of broken) delete rest[key];
  return inStep(settingsSchema.parse(rest), listed && !broken.has("machines"));
}

/** The machine a ComfyUI address becomes when it is the first one (from `comfyUrl`, or the first launch's). */
export const firstMachine = (url: string, dir = ""): Machine => ({ id: FIRST_MACHINE, name: "", url, dir, takes: "all", packs: "ask", families: {}, token: "" });

/**
 * The machines and the first one's address and folder said the same way: settings from before there could be several
 * have only `comfyUrl` and `comfyDir`, which become the first machine; otherwise the first machine says them. A list
 * written empty stays empty: no ComfyUI is expected, and nothing says one is offline.
 */
function inStep(s: Settings, listed = true): Settings {
  if (!s.machines.length) return listed ? s : { ...s, machines: [firstMachine(s.comfyUrl, s.comfyDir)] };
  const [first] = s.machines;
  return { ...s, comfyUrl: first!.url, comfyDir: first!.dir };
}

/** The machines of the user's own (a ComfyUI on this PC or the LAN), the rented pods left out. */
export const ownMachines = (s: Pick<Settings, "machines">): Machine[] => s.machines.filter((m) => !m.rented);

/**
 * What a new install starts with (start.ts, on a database just made): no machine (the first launch adds them), every
 * family on, the first launch to show, and caps on rented GPUs said up front. Written whole, so that the empty list of
 * machines is the list (inStep), not "none written yet".
 */
export async function seedNewInstall(db: Db): Promise<void> {
  await written(db, { machines: [], allFamilies: true, firstLaunch: "pending", rentCaps: { day: 5, month: 25 } });
}

const KEYS = [...Object.keys(settingsSchema.shape), "llm"];

/** The scheme, host and port of an address; the text itself when it is not an address. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The stored key a model keeps when an update does not send one. A key goes with the server it was
 * typed for: an update that points the model at another server (another scheme, host or port) drops
 * it, or the next designer call would send the owner's key to whoever runs that server.
 */
function keptKey(stored: Llm | undefined, baseUrl: unknown): string {
  if (!stored) return "";
  if (typeof baseUrl === "string" && originOf(baseUrl) !== originOf(stored.baseUrl)) return "";
  return stored.apiKey;
}

/** The token a machine keeps when an update does not send one: dropped with a move to another server, as an LLM's key is. */
function keptToken(stored: Machine | undefined, url: unknown): string {
  if (!stored) return "";
  if (typeof url === "string" && originOf(url) !== originOf(stored.url)) return "";
  return stored.token;
}

/**
 * Merges a partial update, validates the whole, stores only the keys that were sent. One write at a time: a list sent
 * the short way ("llm") or a key kept from before is worked out from the settings as they are, and a write landing
 * between that reading and the writing was undone by it.
 */
export function writeSettings(db: Db, patch: unknown): Promise<Settings> {
  return oneAtATime(db, "settings", () => written(db, patch, true));
}

/**
 * A change worked out from the settings as they are (a pin taken off a list, a licence added to one): the reading and
 * the writing in one turn, so that two at once each find the other's change there.
 */
export function updateSettings(db: Db, change: (current: Settings) => Record<string, unknown> | null): Promise<Settings> {
  return oneAtATime(db, "settings", async () => {
    const current = await readSettings(db);
    const patch = change(current);
    return patch ? written(db, patch) : current;
  });
}

/**
 * `fromPage`: a write from the page (PUT /api/settings), whose list of machines may be older than the server's. A rented
 * machine it leaves out is kept (removed only through its own route: a pod dropped by a stale list would bill with
 * nothing watching it), and what only the server knows of one (its pod, its secret, its deploy, the ports it closed) is
 * the server's: the page sets only its idle, its end, its watchdog, whether its ports stay open and whether it makes room
 * on its disk (its card's Make room box).
 */
async function written(db: Db, patch: unknown, fromPage = false): Promise<Settings> {
  // which keys were sent is read from the body itself: parsing it would fill in every default
  const sent = { ...z.record(z.string(), z.unknown()).parse(patch) };
  const unknown = Object.keys(sent).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw httpError(`unknown setting: ${unknown.join(", ")}`);
  // the secrets of pods taken out of Afflatus, deleted on RunPod by name: the server's list, never the page's to write
  if (fromPage) delete sent.leftSecrets;
  if (fromPage) delete sent.pendingDeploys;
  const current = await readSettings(db);
  // "llm" changes the model in use (or makes the first one): the short way, for one model
  if (sent.llm && typeof sent.llm === "object") {
    const used = llmInUse(current);
    const asked = sent.llm as { baseUrl?: unknown; apiKey?: unknown };
    const next = { ...(used ?? { id: "main" }), ...asked, ...(asked.apiKey === undefined ? { apiKey: keptKey(used, asked.baseUrl) } : {}) };
    sent.llms = used ? current.llms.map((l) => (l.id === used.id ? next : l)) : [...current.llms, next];
  } else if (Array.isArray(sent.llms)) {
    // a key that is not sent again stays, as long as the model still points at the same server: the browser is never given it back to send
    sent.llms = (sent.llms as Array<{ id?: string; baseUrl?: unknown; apiKey?: string }>).map((l) => (l.apiKey === undefined ? { ...l, apiKey: keptKey(current.llms.find((c) => c.id === l.id), l.baseUrl) } : l));
  }
  delete sent.llm;
  // the first machine and `comfyUrl` / `comfyDir` are one setting said two ways: whichever was sent, both are written
  if (Array.isArray(sent.machines)) {
    // a machine's token is not sent back by the page, which never has it: it stays, as long as the machine keeps its address
    const list = (sent.machines as Array<{ id?: unknown; url?: unknown; dir?: unknown; token?: unknown }>).map((m) => (m && typeof m === "object" && m.token === undefined ? { ...m, token: keptToken(current.machines.find((c) => c.id === m.id), m.url) } : m));
    if (fromPage) {
      const own = (m: { id?: unknown; rented?: unknown }) => {
        const was = current.machines.find((c) => c.id === m.id);
        // a rented machine is made by Afflatus (add, deploy), never by the page: its pod and secret are not the page's to say
        if (!was?.rented) {
          const { rented: _rented, ...rest } = m;
          return rest;
        }
        const asked = (m.rented && typeof m.rented === "object" ? m.rented : {}) as Record<string, unknown>;
        const pick = Object.fromEntries(["idleMinutes", "idleDo", "watchdogMinutes", "openPorts", "makeRoom"].filter((k) => k in asked).map((k) => [k, asked[k]]));
        return { ...m, rented: { ...was.rented, ...pick } };
      };
      const kept = current.machines.filter((c) => c.rented && !list.some((m) => m.id === c.id));
      list.splice(0, list.length, ...list.map(own), ...kept);
    }
    sent.machines = list;
    // none left (every machine removed, or a rented-only start): `comfyUrl` keeps the last address, for the next one added
    const first = list[0];
    if (first) {
      sent.comfyUrl = first.url;
      sent.comfyDir = first.dir ?? "";
    }
  } else if ("comfyUrl" in sent || "comfyDir" in sent) {
    // the address alone, with no ComfyUI of the user's own yet (a rented-only start, the first launch's "I have one"): it is
    // the first machine, put before the pods. Otherwise it is the first machine's new address
    const [head, ...rest] = current.machines;
    const own = head && !head.rented;
    const first = own ? head : firstMachine(String(sent.comfyUrl ?? current.comfyUrl), String(sent.comfyDir ?? ""));
    const others = own ? rest : current.machines;
    const url = "comfyUrl" in sent ? sent.comfyUrl : first.url;
    sent.machines = [{ ...first, ...("comfyUrl" in sent ? { url: sent.comfyUrl } : {}), ...("comfyDir" in sent ? { dir: sent.comfyDir } : {}), token: own ? keptToken(first, url) : "" }, ...others];
    sent.comfyUrl ??= current.comfyUrl;
    sent.comfyDir ??= current.comfyDir;
  }
  // the page sends what it changed of `notify`, and never the token nor the webhook, which it is not given: merged into what is saved
  if (sent.notify !== undefined) sent.notify = notifyMerged(current.notify, sent.notify);
  // `access` is never the page's to write here: its own routes (access-api.ts) ask for a recent sign-in or the password
  if (sent.access !== undefined) {
    if (fromPage) throw httpError("The Access settings are changed in Settings › Interface › Access, which asks for the password.", 403);
    sent.access = sent.access && typeof sent.access === "object" ? { ...current.access, ...(sent.access as Record<string, unknown>) } : sent.access;
  }
  const next = settingsSchema.parse({ ...current, ...sent });
  const ids = new Set(next.llms.map((l) => l.id));
  if (ids.size !== next.llms.length) throw httpError("two language models have the same id");
  if (new Set(next.machines.map((m) => m.id)).size !== next.machines.length) throw httpError("two ComfyUIs have the same id");
  if (new Set(next.machines.map((m) => m.url.replace(/\/+$/, ""))).size !== next.machines.length) throw httpError("two ComfyUIs have the same address");
  const now = new Date().toISOString();
  try {
    for (const key of Object.keys(sent) as Array<keyof Settings>) {
      const value = JSON.stringify(next[key]);
      await db
        .insertInto("settings")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    }
  } finally {
    // what was read before is stale now, whether or not every key got written
    cached.delete(db);
  }
  return inStep(next);
}

/**
 * Whether an address is a Discord webhook's: Discord's own (https, its domain, /api/webhooks/), or one under DISCORD_URL (a
 * stand-in in the tests). Anything else is refused: the server would post the user's notices wherever it was pointed.
 */
export function discordHookOk(url: string): boolean {
  const stand = envSaid.discordUrl();
  if (stand && url.startsWith(stand)) return true;
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(url);
}

/** What a Telegram bot's token looks like (@BotFather gives "123456789:AA…"): a typo is said at once, not at the first notice. */
const TELEGRAM_TOKEN = /^\d{3,}:[\w-]{20,}$/;

/** `notify` as saved, with what was sent of it (some fields, some kinds' channels) put over it; a webhook or a token that cannot be one refused. */
function notifyMerged(current: NotifySettings, asked: unknown): unknown {
  if (!asked || typeof asked !== "object") return asked;
  const a = asked as Partial<Record<keyof NotifySettings, unknown>>;
  if (typeof a.discordWebhook === "string" && a.discordWebhook.trim() && !discordHookOk(a.discordWebhook.trim())) throw httpError("That is not a Discord webhook: its address starts https://discord.com/api/webhooks/");
  if (typeof a.telegramToken === "string" && a.telegramToken.trim() && !TELEGRAM_TOKEN.test(a.telegramToken.trim())) throw httpError("That is not a Telegram bot token: @BotFather gives one like 123456789:AAE…");
  const sentEvents = a.events && typeof a.events === "object" ? (a.events as Record<string, unknown>) : {};
  const events = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, { ...current.events[k], ...(sentEvents[k] && typeof sentEvents[k] === "object" ? sentEvents[k] : {}) }]));
  return { ...current, ...a, events };
}

/** What the browser may see: secrets are replaced by whether they are set. */
export function publicSettings(s: Settings) {
  const open = ({ apiKey, ...l }: Llm) => ({ ...l, hasApiKey: Boolean(apiKey) });
  const used = llmInUse(s);
  return {
    // a machine's token stays here: the page is told whether there is one, and its end, to tell two apart
    machines: s.machines.map(({ token, ...m }) => ({ ...m, tokenEnd: token ? token.slice(-4) : "" })),
    comfyUrl: s.comfyUrl,
    comfyDir: s.comfyDir,
    unloadAfterMinutes: s.unloadAfterMinutes,
    /** The model in use, the short way: what tells whether the designer can work. */
    llm: { baseUrl: used?.baseUrl ?? "", model: used?.model ?? "", hasApiKey: Boolean(used?.apiKey), vision: used?.vision ?? false },
    llms: s.llms.map(open),
    designerLlm: used?.id ?? "",
    designerInstructions: s.designerInstructions,
    designerInstruction: s.designerInstructions.some((i) => i.id === s.designerInstruction) ? s.designerInstruction : "",
    designerGuides: s.designerGuides,
    tagCheck: s.tagCheck,
    families: s.families,
    allFamilies: s.allFamilies,
    firstLaunch: s.firstLaunch,
    hasCivitaiKey: Boolean(s.civitaiKey),
    hasHuggingFaceToken: Boolean(s.huggingFaceToken),
    hasRunpodKey: Boolean(s.runpodKey),
    runpodS3User: s.runpodS3User,
    hasRunpodS3Secret: Boolean(s.runpodS3Secret),
    rentCaps: s.rentCaps,
    costs: s.costs,
    lastDeploy: s.lastDeploy,
    volumeUnusedDays: s.volumeUnusedDays,
    bootLogDays: s.bootLogDays,
    finish: s.finish,
    slotFiles: s.slotFiles,
    acceptedPresets: s.acceptedPresets,
    civitaiLookups: s.civitaiLookups,
    updateChecks: s.updateChecks,
    afflatusUpdateChecks: s.afflatusUpdateChecks,
    downloadModels: s.downloadModels,
    renderHistoryDays: s.renderHistoryDays,
    unkeptDays: s.unkeptDays,
    binDays: s.binDays,
    bar: s.bar,
    pinnedProjects: s.pinnedProjects,
    // the bot's token and the webhook stay here: anyone who has either can write as Afflatus
    notify: { hasTelegramToken: Boolean(s.notify.telegramToken), telegramChat: s.notify.telegramChat, hasDiscordWebhook: Boolean(s.notify.discordWebhook), picture: s.notify.picture, events: s.notify.events },
    // the password's hash stays here: the page is told whether there is one, and since when
    access: { hasPassword: s.access.password !== null, passwordSetAt: s.access.password?.setAt ?? null, localNoPassword: s.access.localNoPassword, stayDays: s.access.stayDays, resetTelegram: s.access.resetTelegram, hasMetricsToken: Boolean(s.access.metricsToken) },
  };
}
