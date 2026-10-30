import { createHash } from "node:crypto";
import { z } from "zod";
import { LIMITS, presetFileSchema, sigmaOfOldDenoise } from "@afflatus/core";
import { envSaid } from "./config";
import type { Db } from "./db";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { tokenSecret } from "./runpod";

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
  /** SeedVR2 (restores + enlarges, any clip), H3's latent re-sample (H3 clips; others take SeedVR2), RTX VSR, a pixel upscale model, H3's Face refine (H3 clips; others skipped). */
  route: z.enum(["seedvr", "latent", "rtx", "model", "face"]).default("seedvr"),
  factor: z.number().min(1).max(4).default(2),
  colour: z.enum(["lab", "wavelet", "adain", "none"]).default("lab"),
  /** The pixel route's model file; empty = the first found. */
  upscaleModel: z.string().max(200).default(""),
  /** H3's latent re-sample: the σ it starts at (the dialog's denoise), eased to 0 over its steps on a karras curve. */
  latentNoise: z.number().min(0.05).max(0.95).default(0.35),
  latentSteps: z.number().int().min(1).max(6).default(3),
  /** Face refine's denoise on the smallest faces. */
  faceDenoise: z.number().min(0.3).max(0.6).default(0.45),
  /** Face refine with the latent re-sample, in the same job, on the clips whose model offers it (the rethink's Finish, step 10). */
  face: z.boolean().default(false),
  /** SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames: z.number().int().min(0).max(49).default(0),
  /** RCAS after a pixel route (SeedVR2, RTX, a model), 0 to 1; 0 = off. */
  sharpen: z.number().min(0).max(1).default(0),
  /** The models a finish runs on (card #159), "" for each clip's own: Face refine's (a file, or the clip's own model), H3's latent upscaler, SeedVR2's. */
  faceModel: z.string().max(200).default(""),
  latentModel: z.string().max(200).default(""),
  seedvrModel: z.string().max(200).default(""),
});

/**
 * The Finish settings as they read today. Before card #141 the re-sample's denoise was `latentDenoise`, BasicScheduler's at
 * the clip's shift: read as the σ it started at, at the H3 forms' default shift (11; the settings know no clip), its steps
 * kept. The pair the dialog started on (0.15, 2 steps) was never a choice: both left out, the new defaults apply.
 */
export function finishNow(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("latentDenoise" in raw)) return raw;
  const { latentDenoise, ...rest } = raw as Record<string, unknown>;
  if ("latentNoise" in rest || typeof latentDenoise !== "number" || !(latentDenoise > 0)) return rest;
  const steps = typeof rest.latentSteps === "number" ? rest.latentSteps : 2;
  const sigma = sigmaOfOldDenoise({ denoise: latentDenoise, steps, shift: 11 }, { denoise: 0.15, steps: 2 });
  if (sigma === null) {
    const { latentSteps: _, ...left } = rest;
    return left;
  }
  return { ...rest, latentNoise: Math.min(0.95, Math.max(0.05, sigma)) };
}

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
  /**
   * The model set it was deployed with, by id ("" for none): its files are offered in the lists, greyed, while it does not
   * list them (stopped, still fetching), and a job that picks one waits for it (filePlaces.ts). The server's alone.
   */
  set: z.string().max(80).default(""),
  /** The files of that set its deploy asked for (some may have been unticked): kept, where `files` is emptied once handed over. */
  setFiles: z.array(z.strictObject({ file: z.string().max(400), folder: z.string().max(120), size: z.number().int().nonnegative().optional() })).max(300).default([]),
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
  /**
   * The MCP token whose deploy_pod or start_pod started its current run, by id (mcpMachines.ts); empty: the user's Start or
   * Deploy, or the GPU hunt's. Its run is then that token's spend, and it stops once that token's cap is reached. The
   * server's alone: what the page sends of it is not taken (writeSettings keeps only the idle choices of a rented machine).
   */
  mcpToken: z.string().max(80).default(""),
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
export const NOTIFY_KINDS = ["renderDone", "renderFailed", "queueEmpty", "renderStuck", "podStopped", "capReached", "balanceLow", "comfyGone", "comfyBusy", "gpuFound", "huntGaveUp", "newDevice"] as const;
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

/** The optional password (Settings › Sign-in, access.ts). */
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
  /**
   * The address its folder was emptied at by hand (Settings): no folder is looked for there again (services.ts comfyFolder,
   * at each start), or the node pack would be written back into a ComfyUI the user said is not on this disk. Another
   * address, or a folder set, ends it. The server's alone: what the page sends of it is not taken (writeSettings). Empty: none.
   */
  dirCleared: z.string().max(2000).default(""),
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
   * ComfyUI's folder on the computer Afflatus runs on, the one that holds custom_nodes and models (main.py's, or the base
   * folder of ComfyUI Desktop and of --base-directory), when they share a disk.
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
  /**
   * Missing model files may be looked for on Hugging Face and Civitai, and the files here hashed and matched there. Off:
   * Afflatus never contacts them on its own; Find models still searches when it is opened, the user asking (card #166).
   * On for a new install; one from before 0.8.4 kept what it had (migration 0101).
   */
  civitaiLookups: z.boolean().default(true),
  /** Once a day, Civitai is asked whether it has newer versions of the models here (only with lookups on; hashes of the files are sent). */
  updateChecks: z.boolean().default(false),
  /** Once a day, GitHub is asked whether a newer Afflatus is out (updates.ts); nothing about the user is sent. Apart from `updateChecks`, which is about the models. */
  afflatusUpdateChecks: z.boolean().default(true),
  /**
   * Missing model files may be fetched into ComfyUI (by Afflatus, its node pack or ComfyUI-Manager), each asked first with
   * its size. Off: Afflatus never asks ComfyUI to download anything. On for a new install (card #166, migration 0101).
   */
  downloadModels: z.boolean().default(true),
  /**
   * Where a model folder's downloads go when ComfyUI reads it from several places (card #59), by machine id then folder
   * name: one of the paths ComfyUI lists for it, as it says it. A folder not named takes ComfyUI's own models/<folder>.
   */
  downloadPlaces: z.record(z.string().max(40), z.record(z.string().max(120), z.string().max(1000))).default({}),
  /**
   * How many days the time of each render is kept one by one. Older ones are folded into figures per
   * model and day, which stay for good. 0: each one is kept for good.
   */
  renderHistoryDays: z.number().int().min(0).max(3650).default(90),
  /**
   * How many days a finished job (done, failed, stopped) stays in the Queue's history once it ended, when nothing still
   * names it (tidy.ts pruneJobs: a render row, a clip, a timeline, an item of the library); 0: every job is kept for good.
   */
  jobHistoryDays: z.number().int().min(0).max(3650).default(30),
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
  /**
   * The settings pinned to the top of the model forms (Pinned fields), per model family (the H3 forms share the family "h3",
   * so a pin on one shows on all of them): input ids in their order on the Pinned card. An id a family's forms no longer have
   * is kept here and skipped by the form; a family with no pin left is not listed.
   */
  pinnedFields: z
    .record(z.string().min(1).max(120), z.array(z.string().min(1).max(120)).max(LIMITS.pinnedFields).refine((ids) => new Set(ids).size === ids.length, "a field is pinned once"))
    .refine((byFamily) => Object.keys(byFamily).length <= 200, "pins for 200 families at most")
    .default({}),
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
  rest.finish = finishNow(rest.finish);
  // a list of machines never written is an install from before there could be several (or none): its ComfyUI is the first
  // machine. One written, even empty (a new install's, seedNewInstall; every machine removed), is the list as it is
  const listed = Array.isArray(rest.machines);
  // read machine by machine: one the schema no longer took whole set the whole list aside, and with it every rented pod
  // out of the idle stop, the caps and Costs while RunPod billed on
  const aside: MachineSetAside[] = [];
  if (listed) {
    const read = readMachines(rest.machines as unknown[]);
    aside.push(...read.aside);
    rest.machines = read.machines;
    // none read, rows set aside beside them, is still a list written: the address kept with it is not made the first machine
    // again (a list emptied by hand, an unread row of the user's own left, brought back "Your ComfyUI", expected by the queue)
    for (const a of aside) console.warn(`[settings] the stored machine ${a.label} ${a.mended ? `had ${a.fields.join(", ")} set back to the default` : `could not be read and was set aside${a.pod ? ` (its pod ${a.pod} is stopped: nothing here can follow it)` : ""}`}: ${a.why}`);
  }
  const parsed = settingsSchema.safeParse(rest);
  if (parsed.success) return withAside(inStep(parsed.data, listed), aside);
  // a stored value the schema no longer takes (an address without its scheme, say) falls back to its default rather than locking every setting
  const broken = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
  console.warn(`[settings] stored values that are no longer valid were set aside: ${[...broken].join(", ")}`);
  for (const key of broken) delete rest[key];
  return withAside(inStep(settingsSchema.parse(rest), listed && !broken.has("machines")), aside);
}

/**
 * A stored machine the schema did not take whole (load). `mended`: only some of its settings were not, and they took their
 * default: the machine is in the list (a pod is followed as before). Otherwise it is left out of the list, its row kept as
 * stored (`raw`, written back with the list: writeSettings), and its pod, when its id reads, stopped by the follow loop
 * (rentedFollow.ts): nothing here could watch its idle time nor count it against the caps.
 */
export interface MachineSetAside {
  raw: unknown;
  /** What the page names it by to forget it (forgetSetAside): its stored row's hash, the same at every read of the same row. */
  key: string;
  /** Its id as stored (it may be the part not read); empty when it has none. */
  id: string;
  /** Its name, else its address, else its id: what the log and the page call it. */
  label: string;
  mended: boolean;
  /** The settings of it that took their default (written back as stored, and said, until the machine is saved: written). */
  fields: string[];
  /** Its RunPod pod's id, when it is a rented machine whose pod id reads. */
  pod: string | null;
  /** The schema's word on it, the setting named: the one that set it aside, or the first one mended. */
  why: string;
}

/**
 * A machine's settings that cannot take a default: without one of them it is not a machine. Whether it was deployed and
 * whether it is a fill pod neither: their default (false) changes what is done to its pod (a cap's or a watchdog's stop
 * where it was terminated, a fill pod given renders), so a row that lost one is set aside, its pod stopped, never mended.
 */
const MACHINE_CORE = new Set(["id", "url", "rented", "rented.provider", "rented.pod", "rented.deployed", "rented.fill"]);

/** The setting a schema issue on a stored machine is about ("takes", "rented.idleDo"). */
type Issue = { path: PropertyKey[]; message: string };
const machineKey = (issue: Issue): string => (issue.path[0] === "rented" && issue.path.length > 1 ? `rented.${String(issue.path[1])}` : String(issue.path[0] ?? ""));

/** A schema issue said with the setting it is about. */
const issueSaid = (issue: Issue | undefined): string => (issue ? `${machineKey(issue) || "the row"}: ${issue.message}` : "");

/** The stored machines read one by one: those read (some mended), and those set aside. */
function readMachines(rows: unknown[]): { machines: Machine[]; aside: MachineSetAside[] } {
  const machines: Machine[] = [];
  const aside: MachineSetAside[] = [];
  for (const raw of rows) {
    const first = machineSchema.safeParse(raw);
    if (first.success) {
      machines.push(first.data);
      continue;
    }
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const rented = row.rented && typeof row.rented === "object" && !Array.isArray(row.rented) ? (row.rented as Record<string, unknown>) : null;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const said = { raw, key: createHash("sha256").update(JSON.stringify(raw) ?? "").digest("hex").slice(0, 16), id: text(row.id), label: text(row.name).trim() || text(row.url) || text(row.id) || "with no id", pod: (rented?.provider === "runpod" && text(rented.pod)) || null };
    // a setting it no longer takes is dropped, to take its default, a few times over (one dropped may show the next)
    const copy: Record<string, unknown> = { ...row, ...(rented ? { rented: { ...rented } } : {}) };
    const fields: string[] = [];
    let issues = first.error.issues;
    let mended: Machine | null = null;
    // what is said of it: the setting that set it aside, not the first issue (one that would have been mended)
    let why = issueSaid(issues[0]);
    for (let round = 0; round < 4 && !mended; round++) {
      const keys = [...new Set(issues.map(machineKey))];
      const fatal = issues.find((i) => !machineKey(i) || MACHINE_CORE.has(machineKey(i)));
      if (fatal) {
        why = issueSaid(fatal);
        break;
      }
      for (const k of keys) {
        if (k.startsWith("rented.")) delete (copy.rented as Record<string, unknown>)[k.slice("rented.".length)];
        else delete copy[k];
        fields.push(k);
      }
      const again = machineSchema.safeParse(copy);
      if (again.success) mended = again.data;
      else {
        issues = again.error.issues;
        why = issueSaid(issues[0]);
      }
    }
    // a pod's idle action lost takes the one that bills less where the pod is Afflatus's to end (a deployed one: terminated,
    // as its deploy defaults to), not the schema's stop, which keeps a pod billing for its disk
    if (mended?.rented && fields.includes("rented.idleDo")) mended.rented.idleDo = mended.rented.deployed ? "terminate" : "stop";
    if (mended) machines.push(mended);
    aside.push({ ...said, why, mended: Boolean(mended), fields: mended ? fields : [] });
  }
  return { machines, aside };
}

/** What load set aside of the stored machines, by the settings read with it (machinesSetAside). */
const asideOf = new WeakMap<Settings, MachineSetAside[]>();

function withAside(s: Settings, aside: MachineSetAside[]): Settings {
  if (aside.length) asideOf.set(s, aside);
  return s;
}

/** The stored machines these settings were read without, whole or in part: said on the page, a pod followed for stopping. */
export const machinesSetAside = (s: Settings): MachineSetAside[] => asideOf.get(s) ?? [];

/** The machine a ComfyUI address becomes when it is the first one (from `comfyUrl`, or the first launch's). */
export const firstMachine = (url: string, dir = ""): Machine => ({ id: FIRST_MACHINE, name: "", url, dir, dirCleared: "", takes: "all", packs: "ask", families: {}, token: "" });

/**
 * The machines and the first one's address and folder said the same way: settings from before there could be several
 * have only `comfyUrl` and `comfyDir`, which become the first machine; otherwise the first machine says them. A list
 * written empty stays empty: no ComfyUI is expected, and nothing says one is offline.
 */
function inStep(s: Settings, listed = true): Settings {
  if (!s.machines.length) {
    // never written (0.3.0, 0.4.0): the address is the user's own ComfyUI as typed, a pod of their own on RunPod's proxy
    // too (Afflatus rented none then, and has always kept the pods it rents in the list), so it becomes the first machine as it is
    if (!listed) return { ...s, machines: [firstMachine(s.comfyUrl, s.comfyDir)] };
    // a pod's address kept from before only a ComfyUI of the user's own was kept so (writeSettings), its pod removed since:
    // never offered as "Your ComfyUI", ComfyUI's usual one instead
    return podProxyUrl(s.comfyUrl) ? { ...s, comfyUrl: settingsSchema.shape.comfyUrl.parse(undefined) } : s;
  }
  const [first] = s.machines;
  return { ...s, comfyUrl: first!.url, comfyDir: first!.dir };
}

/**
 * Whether an address has a rented pod's shape, RunPod's proxy (https://<pod>-<port>.proxy.runpod.net, runpod.ts podUrl):
 * what tells a pod's address kept after its pod was removed, when no machine names it. RUNPOD_PROXY's stand-in shapes
 * (the demo's, the tests') are not taken: theirs is 127.0.0.1 and a port, which a ComfyUI of the user's own can be too.
 */
export const podProxyUrl = (url: string): boolean => /^https:\/\/[a-z0-9-]+-\d+\.proxy\.runpod\.net\/*$/i.test(url.trim());

/** The machines of the user's own (a ComfyUI on this PC or the LAN), the rented pods left out. */
/** Whether a machine's folder was emptied by hand at the address it has now (writeSettings): not to be looked for. */
export const folderLeftEmpty = (m: Machine): boolean => Boolean(m.dirCleared) && !m.dir.trim() && originOf(m.dirCleared) === originOf(m.url);

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
 * on its disk (its card's Make room box). `forget`: the key of a stored row set aside whole to drop (forgetSetAside).
 */
async function written(db: Db, patch: unknown, fromPage = false, forget = ""): Promise<Settings> {
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
  // the machines whose folder this write empties on purpose: the Connection card's folder saved empty (`comfyDir`), or a
  // machine's own sent with `clearDir`. Any other empty folder is not taken as the user's word (see `dirCleared` below)
  const byHand = new Set<unknown>();
  // the first machine and `comfyUrl` / `comfyDir` are one setting said two ways: whichever was sent, both are written
  if (Array.isArray(sent.machines)) {
    // a machine's token is not sent back by the page, which never has it: it stays, as long as the machine keeps its address
    const list = (sent.machines as Array<{ id?: unknown; url?: unknown; dir?: unknown; token?: unknown; clearDir?: unknown }>).map((m) => {
      if (!m || typeof m !== "object") return m;
      const { clearDir, ...rest } = m;
      if (clearDir === true) byHand.add(m.id);
      return rest.token === undefined ? { ...rest, token: keptToken(current.machines.find((c) => c.id === m.id), m.url) } : rest;
    });
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
      // a folder the page sends empty, not cleared on purpose, at the same ComfyUI, is a list read before the server found
      // it (services.ts comfyFolder, at a start): the folder stays, or a Packs click in that moment lost it, and marked it
      // "emptied by hand" so that it was never looked for again
      const stale = (m: { id?: unknown; url?: unknown; dir?: unknown }) => {
        const was = current.machines.find((c) => c.id === m.id);
        const empty = !(typeof m.dir === "string" && m.dir.trim());
        return was && empty && !byHand.has(m.id) && was.dir.trim() && typeof m.url === "string" && originOf(m.url) === originOf(was.url) ? { ...m, dir: was.dir } : m;
      };
      list.splice(0, list.length, ...list.map(own).map(stale), ...kept);
    }
    sent.machines = list;
    // a machine removed takes the download places chosen on it along (a terminated pod's could not even be reset: no
    // ComfyUI answers for it any more)
    const ids = new Set((list as Array<{ id?: unknown }>).map((m) => m?.id));
    const places = sent.downloadPlaces && typeof sent.downloadPlaces === "object" ? (sent.downloadPlaces as Record<string, unknown>) : current.downloadPlaces;
    if (Object.keys(places).some((id) => !ids.has(id))) sent.downloadPlaces = Object.fromEntries(Object.entries(places).filter(([id]) => ids.has(id)));
    // none left (every machine removed, or a rented-only start): `comfyUrl` keeps the last address, for the next one added.
    // Only a ComfyUI of the user's own is kept so: a pod's proxy address was offered, once the pod was gone, as "Your ComfyUI"
    const first = (list as Array<{ url?: unknown; dir?: unknown; rented?: unknown }>).find((m) => !m.rented);
    if (first) {
      sent.comfyUrl = first.url;
      sent.comfyDir = first.dir ?? "";
    } else {
      // with pods only, the address said (inStep) is the first pod's: the one kept is the one stored, unless that is a pod's
      // too (written so before), then ComfyUI's usual one
      const pods = new Set([...current.machines, ...(list as Array<{ url?: unknown; rented?: unknown }>)].filter((m) => m.rented).map((m) => m.url));
      const row = await db.selectFrom("settings").select("value").where("key", "=", "comfyUrl").executeTakeFirst();
      let value: unknown;
      try {
        value = row ? JSON.parse(row.value) : undefined;
      } catch {
        // not JSON: the usual one
      }
      const stored = httpUrl.safeParse(value);
      sent.comfyUrl = stored.success && !pods.has(stored.data) && !podProxyUrl(stored.data) ? stored.data : settingsSchema.shape.comfyUrl.parse(undefined);
    }
  } else if ("comfyUrl" in sent || "comfyDir" in sent) {
    // the address alone, with no ComfyUI of the user's own yet (a rented-only start, the first launch's "I have one"): it is
    // the first machine, put before the pods. Otherwise it is the first machine's new address
    const [head, ...rest] = current.machines;
    const own = head && !head.rented;
    const first = own ? head : firstMachine(String(sent.comfyUrl ?? current.comfyUrl), String(sent.comfyDir ?? ""));
    if ("comfyDir" in sent) byHand.add(first.id);
    const others = own ? rest : current.machines;
    const url = "comfyUrl" in sent ? sent.comfyUrl : first.url;
    // another ComfyUI (its address moved to another origin, as the token is dropped): the old one's folder goes with it,
    // or its node pack was written there and its models read from there; the new one's is looked for again (setup-api)
    const moved = own && !("comfyDir" in sent) && typeof url === "string" && originOf(url) !== originOf(first.url);
    sent.machines = [{ ...first, ...("comfyUrl" in sent ? { url: sent.comfyUrl } : {}), ...("comfyDir" in sent ? { dir: sent.comfyDir } : moved ? { dir: "" } : {}), token: own ? keptToken(first, url) : "" }, ...others];
    sent.comfyUrl ??= current.comfyUrl;
    sent.comfyDir ??= moved ? "" : current.comfyDir;
  }
  // a folder emptied by hand (a folder there before, the same ComfyUI, cleared on purpose by this write) is remembered with its
  // address, so that it is not looked for again; set again, or the ComfyUI moved elsewhere, it is forgotten
  if (Array.isArray(sent.machines)) {
    sent.machines = (sent.machines as unknown[]).map((m) => {
      if (!m || typeof m !== "object") return m;
      const { id, url, dir } = m as { id?: unknown; url?: unknown; dir?: unknown };
      const was = current.machines.find((c) => c.id === id);
      const same = (other: string) => typeof url === "string" && originOf(url) === originOf(other);
      const emptied = !(typeof dir === "string" && dir.trim()) && was;
      const cleared = !emptied ? "" : byHand.has(id) && was.dir.trim() && same(was.url) ? url : was.dirCleared && same(was.dirCleared) ? was.dirCleared : "";
      return { ...m, dirCleared: cleared };
    });
  }
  // the page sends what it changed of `notify`, and never the token nor the webhook, which it is not given: merged into what is saved
  if (sent.notify !== undefined) sent.notify = notifyMerged(current.notify, sent.notify);
  // `access` is never the page's to write here: its own routes (access-api.ts) ask for a recent sign-in or the password
  if (sent.access !== undefined) {
    if (fromPage) throw httpError("The Sign-in settings are changed in Settings › Sign-in, which asks for the password.", 403);
    sent.access = sent.access && typeof sent.access === "object" ? { ...current.access, ...(sent.access as Record<string, unknown>) } : sent.access;
  }
  const next = settingsSchema.parse({ ...current, ...sent });
  const ids = new Set(next.llms.map((l) => l.id));
  if (ids.size !== next.llms.length) throw httpError("two language models have the same id");
  if (new Set(next.machines.map((m) => m.id)).size !== next.machines.length) throw httpError("two ComfyUIs have the same id");
  if (new Set(next.machines.map((m) => m.url.replace(/\/+$/, ""))).size !== next.machines.length) throw httpError("two ComfyUIs have the same address");
  // a stored machine set aside whole is written back as it was stored, never dropped by a list read without it: a pod in
  // it bills on RunPod, and its row is what tells it is Afflatus's. One the list now has under its id is the list's, and so
  // is one whose pod a machine of the list follows now (the pod added again under another id: kept, its old row had the
  // follow loop stop the pod the user renders on at every read). One forgotten on the user's word goes (forgetSetAside).
  // A mended machine keeps the settings that took a default as they were stored (said again at the next read) until the
  // page saves that machine changed: a default the user was never shown is not stored as their choice. A setting a write
  // changed is the write's
  const still = machinesSetAside(current).flatMap((a): MachineSetAside[] => {
    if (!a.mended) return a.key === forget || next.machines.some((m) => m.id === a.id || (a.pod !== null && m.rented?.pod === a.pod)) ? [] : [a];
    const was = current.machines.find((m) => m.id === a.id);
    const now = next.machines.find((m) => m.id === a.id);
    if (!was || !now || (fromPage && JSON.stringify(now) !== JSON.stringify(was))) return [];
    const fields = a.fields.filter((f) => JSON.stringify(settingAt(now, f)) === JSON.stringify(settingAt(was, f)));
    return fields.length ? [{ ...a, fields }] : [];
  });
  const unread = still.filter((a) => !a.mended);
  const stored = (m: Machine): unknown => {
    const a = still.find((x) => x.mended && x.id === m.id);
    if (!a) return m;
    const raw = a.raw as Record<string, unknown>;
    const row: Record<string, unknown> = { ...m, ...(m.rented ? { rented: { ...m.rented } } : {}) };
    for (const f of a.fields) {
      if (f.startsWith("rented.")) (row.rented as Record<string, unknown>)[f.slice("rented.".length)] = (raw.rented as Record<string, unknown>)[f.slice("rented.".length)];
      else row[f] = raw[f];
    }
    return row;
  };
  const now = new Date().toISOString();
  try {
    for (const key of Object.keys(sent) as Array<keyof Settings>) {
      const value = key === "machines" && still.length ? JSON.stringify([...next.machines.map(stored), ...unread.map((a) => a.raw)]) : JSON.stringify(next[key]);
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
  // a machine taken out (a pod terminated, a machine removed): what the queue kept of it goes with it
  if ("machines" in sent) await dropGoneMachines(db).catch((err: Error) => console.warn(`[settings] the queue's notes of removed machines stay: ${err.message}`));
  // still set aside, as the next read finds them
  return withAside(inStep(next), "machines" in sent ? still : machinesSetAside(current));
}

/** A machine's setting by its key as set aside ("takes", "rented.idleDo"). */
function settingAt(m: Machine, key: string): unknown {
  if (!key.startsWith("rented.")) return (m as Record<string, unknown>)[key];
  return (m.rented as Record<string, unknown> | undefined)?.[key.slice("rented.".length)];
}

/**
 * A stored machine set aside whole (load) dropped on the user's word (Settings › ComfyUI, its note's Forget): its row is
 * deleted, and a pod's secret is left to delete once the pod is gone (sweepSecrets), as a removed machine's is. Whether its
 * pod still bills is the caller's to ask first (rented.ts forgetSetAside). Null when no such row is stored now.
 */
export function forgetSetAside(db: Db, key: string): Promise<MachineSetAside | null> {
  return oneAtATime(db, "settings", async () => {
    const current = await readSettings(db);
    const a = machinesSetAside(current).find((x) => !x.mended && x.key === key);
    if (!a) return null;
    const named = (a.raw as { rented?: { secret?: unknown } } | null)?.rented?.secret;
    const secret = typeof named === "string" && named && named.length <= 80 ? named : a.pod ? tokenSecret(a.pod) : "";
    // (a pod id or a secret too long to be stored is not one RunPod has: nothing to delete)
    const left = a.pod && a.pod.length <= 80 && secret.length <= 80 ? { leftSecrets: [...current.leftSecrets.filter((l) => l.pod !== a.pod), { secret, pod: a.pod }] } : {};
    await written(db, { machines: current.machines, ...left }, false, key);
    return a;
  });
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

/** A mended machine's settings that took a default, each with the value it has meanwhile ("idleDo: terminate"); a token's left unsaid. */
function mendedNow(s: Settings, a: MachineSetAside): string[] {
  const m = s.machines.find((x) => x.id === a.id);
  return a.fields.map((f) => {
    const name = f.replace(/^rented\./, "");
    const value = m && f !== "token" ? settingAt(m, f) : undefined;
    return value === undefined || value === "" ? name : `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  });
}

/** What the browser may see: secrets are replaced by whether they are set. */
export function publicSettings(s: Settings, here: (url: string) => boolean = () => false) {
  const open = ({ apiKey, ...l }: Llm) => ({ ...l, hasApiKey: Boolean(apiKey) });
  const used = llmInUse(s);
  return {
    // a machine's token stays here: the page is told whether there is one, and its end, to tell two apart. `local`: its
    // ComfyUI runs on this machine (setup-api passes modelDownload's onThisMachine), what the page says of its node pack
    machines: s.machines.map(({ token, dirCleared: _cleared, ...m }) => ({ ...m, tokenEnd: token ? token.slice(-4) : "", local: !m.rented && here(m.url) })),
    // the stored machines not read whole (load): said on Settings, never their row (it may hold a token). A mended one says
    // what each setting that took a default is meanwhile; `key` is what its note's Forget names it by
    machinesSetAside: machinesSetAside(s).map((a) => ({ key: a.key, label: a.label, mended: a.mended, fields: a.fields, now: a.mended ? mendedNow(s, a) : [], pod: Boolean(a.pod), why: a.why })),
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
    downloadPlaces: s.downloadPlaces,
    renderHistoryDays: s.renderHistoryDays,
    jobHistoryDays: s.jobHistoryDays,
    unkeptDays: s.unkeptDays,
    binDays: s.binDays,
    bar: s.bar,
    pinnedProjects: s.pinnedProjects,
    pinnedFields: s.pinnedFields,
    // the bot's token and the webhook stay here: anyone who has either can write as Afflatus
    notify: { hasTelegramToken: Boolean(s.notify.telegramToken), telegramChat: s.notify.telegramChat, hasDiscordWebhook: Boolean(s.notify.discordWebhook), picture: s.notify.picture, events: s.notify.events },
    // the password's hash stays here: the page is told whether there is one, and since when
    access: { hasPassword: s.access.password !== null, passwordSetAt: s.access.password?.setAt ?? null, localNoPassword: s.access.localNoPassword, stayDays: s.access.stayDays, resetTelegram: s.access.resetTelegram, hasMetricsToken: Boolean(s.access.metricsToken) },
  };
}

/** What the queue keeps of each machine but the first (queue.ts): paused or not, and what it last loaded, by machine id. */
const MACHINE_NOTE = /^queue\.(?:paused|model|loads)\.(.+)$/;

/**
 * The queue's notes of machines no longer stored (a pod terminated, a machine removed, while this process ran or not),
 * deleted: they were never read again, 60 of the owner's 93 settings were a gone pod's, and a machine added later under a
 * gone one's id took its pause. The ids are read from the stored list itself, the rows set aside included; when it cannot
 * be read, or one of its rows has no id, nothing goes. Read and deleted in one transaction: a machine added in between,
 * its notes written at once (a newcomer paused by Pause all), keeps them. Returns how many went.
 */
export async function dropGoneMachines(db: Db): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const row = await tx.selectFrom("settings").select("value").where("key", "=", "machines").executeTakeFirst();
    let stored: unknown;
    try {
      stored = row ? JSON.parse(row.value) : undefined;
    } catch {
      return 0;
    }
    if (!Array.isArray(stored)) return 0;
    const ids = stored.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined));
    if (!ids.every((id): id is string => typeof id === "string" && id !== "")) return 0;
    const kept = new Set(ids);
    const notes = await tx.selectFrom("settings").select("key").where("key", "like", "queue.%.%").execute();
    const gone = notes.map((n) => n.key).filter((key) => {
      const id = MACHINE_NOTE.exec(key)?.[1];
      return id !== undefined && !kept.has(id);
    });
    for (let i = 0; i < gone.length; i += 500) await tx.deleteFrom("settings").where("key", "in", gone.slice(i, i + 500)).execute();
    return gone.length;
  });
}
