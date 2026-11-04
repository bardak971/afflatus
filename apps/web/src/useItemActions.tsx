import { useRef, type RefObject } from "react";
import { RANDOM_SEED, typedSeed } from "@afflatus/core";
import { useQueueVariation } from "./queueVariation";
import type { Asset } from "./api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { eraseNow } from "./binActions";
import { askAboutDisk } from "./Confirm";
import { useSettings, useSetup, type useAsset } from "./data";
import { saveAsset } from "./download";
import { ACTIONS, itemActions, PASS_KEYS, sentPrompt, type ActionId, type ItemFacts, type Runs, type Tunes } from "./itemActions";
import { TUNED_ROWS, tunedJob, useTune } from "./passTune";
import type { QueuedJob } from "./queueVariation";
import { VARY, varyJob } from "./vary";
import { useItemMutations, useTimelineSubmenu } from "./itemMutations";
import { canCopyPicture } from "./secureContext";
import { useBanners } from "./store";
import { handsInput, NO_HAND_DETECTOR, OPS } from "./viewer/shared";
import { useMediaExtract } from "./viewer/useMediaExtract";
import { useNewDraftActions } from "./viewer/useNewDraftActions";
import { useFlash } from "./hooks";

/** How long a pass button says "Queued" after the server took the job. */
const QUEUED_MS = 1400;

/** For a place whose menu is closed: the hooks are worked out for nothing. */
export const NO_ASSET = { id: "", kind: "image" } as Asset;

const noop = () => {};

/**
 * What each action of an item's list does (itemActions.tsx), the one body for every place: the viewer, a tile's menu,
 * the command bar. A place hands its own Open, Trim, Compare, Details and the like (`list`'s overrides), where they
 * mean something else there; the rest is done the same everywhere. `sayErrors`: what fails is said in a banner (the
 * viewer's side says it under its buttons instead).
 */
export function useItemActions({ asset, detail, enabled = true, leave = noop, onOpened, into, player, trim = false, sayErrors = false, timeline: timelineOpts }: {
  asset: Asset;
  detail: ReturnType<typeof useAsset>;
  /** Off while the menu that uses it is closed: nothing is read for it. */
  enabled?: boolean;
  /** Called before a form opens (the viewer over the screen steps aside). */
  leave?(): void;
  /** An item made from this one (a frame, its sound, a mirrored copy): shown in its turn. */
  onOpened(asset: Asset): void;
  /** What is queued from here belongs to this draft and lands in this folder. */
  into?: { draft?: string; folder?: string };
  /** The video playing it, whose frame Save frame takes; none: the first frame. */
  player?: RefObject<HTMLVideoElement | null>;
  trim?: boolean;
  sayErrors?: boolean;
  timeline?: Parameters<typeof useTimelineSubmenu>[0];
}) {
  const drafts = useNewDraftActions({ asset, detail, leave, enabled });
  const noPlayer = useRef<HTMLVideoElement | null>(null);
  const media = useMediaExtract({ asset, trim, player: player ?? noPlayer, onOpened });
  const queued = useQueueVariation(into);
  const mutations = useItemMutations();
  const timeline = useTimelineSubmenu(timelineOpts);
  const setup = useSetup();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const { a, g, recipe, reuse, carrier, carryOn, opener, openerName, animate, mover, moverName, transfer, openerChoices, moverChoices, follower, follow, toolFor, toolInput, openTool, vary } = drafts;
  const openTune = useTune((t) => t.open);
  const said = (title: string) => (sayErrors ? { onError: mutations.failed(title) } : undefined);
  // Send to: the file itself, to the Telegram chat and the Discord channel set up for the notifications
  const notify = useSettings().data?.notify;
  const channels = [
    ...(notify?.hasTelegramToken && notify.telegramChat ? [{ id: "telegram" as const, name: "Telegram" }] : []),
    ...(notify?.hasDiscordWebhook ? [{ id: "discord" as const, name: "Discord" }] : []),
  ];
  const share = useMutation({
    mutationFn: (v: { id: string; channel: "telegram" | "discord"; name: string }) => api.shareAsset(v.id, v.channel).then(() => v),
    onSuccess: (v) => say({ id: `share:${v.id}:${v.channel}`, tone: "good", title: `Sent to ${v.name}` }),
    onError: mutations.failed("It could not be sent"),
  });

  // the button of a pass just queued says so for a moment ("Queued", the ok look), on the item it was queued for: the
  // job shows in the queue only once the server has it, and a click with nothing on screen reads as one that missed
  const [done, setDone] = useFlash<{ id: string; action: ActionId } | null>(null, QUEUED_MS);
  const flash = (action: ActionId) => setDone({ id: a.id, action });
  /** A job queued from here, its button flashing once the server took it. */
  const queue = (action: ActionId, job: Parameters<typeof queued.mutate>[0]) => queued.mutate(job, { onSuccess: () => flash(action) });

  /** The job of a pass queued at once with the picture's parameters (Upscale, Face refine, Remove background). */
  const quickJob = (key: string): QueuedJob | undefined => {
    const tool = toolFor(key);
    return tool ? { recipe: tool, stored: toolInput(tool), label: OPS[key]!.label, from: a.id } : undefined;
  };
  const quick = (key: string) => {
    const job = quickJob(key);
    const action = (Object.keys(PASS_KEYS) as ActionId[]).find((id) => PASS_KEYS[id] === key);
    if (job && action) queue(action, job);
  };
  /**
   * The face detailer on the hand detector, on the values the recipe starts on for hands (denoise, crop factor, a
   * prompt about hands); the picture's negative prompt and model carried as for the face. A ComfyUI without the
   * detector is told where to get it rather than handed a face pass.
   */
  const handsJob = (): QueuedJob | undefined => {
    const tool = toolFor("h");
    const way = tool && handsInput(tool, setup.data?.recipes.find((x) => x.id === tool.id)?.options, Boolean(setup.data?.comfy.online));
    if (!tool || !way) return undefined;
    if (way.missing) {
      say({ id: `queued:${Date.now()}`, tone: "bad", title: "Hand refine could not be queued", text: NO_HAND_DETECTOR, href: "/settings/models", go: "Open Settings" });
      return undefined;
    }
    return { recipe: tool, stored: { ...toolInput(tool), ...way.values }, label: OPS.h!.label, from: a.id };
  };
  const hands = () => {
    const job = handsJob();
    if (job) queue("hand", job);
  };
  /** Vary subtle or strong: its model's img2img at the family's denoise, on a new seed (vary.ts). */
  const varyOf = (action: ActionId): QueuedJob | undefined => {
    const how = VARY[action];
    return how && g && recipe && vary ? varyJob(how, ACTIONS[action].label, g, recipe, vary, a.id) : undefined;
  };
  const variationJob = (): QueuedJob | undefined => (g && recipe ? { recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" } : undefined);
  /** The job each pass with settings queues, as its own button would: what its popover starts on. */
  const jobOf = (action: ActionId): QueuedJob | undefined => {
    if (VARY[action]) return varyOf(action);
    if (action === "variation") return variationJob();
    if (action === "hand") return handsJob();
    const key = PASS_KEYS[action];
    return key ? quickJob(key) : undefined;
  };
  /** Shift+click or ▾ on a pass: its key rows in the popover, then queued from there (TunePopover.tsx). */
  const tunes = Object.fromEntries((Object.keys(TUNED_ROWS) as ActionId[]).map((action) => [action, (at: Parameters<typeof openTune>[0]) => {
    const job = jobOf(action);
    if (job) openTune(at, { action, title: ACTIONS[action].label, job, queue: (changed, count) => queue(action, tunedJob(job, changed, count)) });
  }])) as Tunes;
  /** A pass that opens a form with the picture in place (Inpaint, Edit, Outpaint). */
  const openPass = (key: string) => {
    const tool = toolFor(key);
    if (tool) openTool.mutate(tool.id, said(`Could not open ${OPS[key]!.label}`));
  };
  const seed = typedSeed(g?.resolved.seed);
  // the inputs as sent (a cast worked in), read by the form's own inputs where its recipe is still here
  const prompt = g ? sentPrompt(g.inputs, recipe?.inputs) : null;
  const reading = enabled && Boolean(asset.id) && detail.data?.id !== asset.id && detail.isFetching;
  const passes = Object.fromEntries([
    ...Object.entries(PASS_KEYS).flatMap(([id, k]) => {
      const tool = toolFor(k!);
      return tool ? [[id, tool.title]] : [];
    }),
    ...(vary ? Object.keys(VARY).map((id) => [id, vary.title]) : []),
  ]) as Partial<Record<ActionId, string>>;

  /** What the list is made from, for the item; `more`: what the place knows (Compare, Trim open, its seed…). */
  const facts = (more: Partial<ItemFacts> = {}): ItemFacts => ({
    kind: a.kind, inBin: a.inBin, kept: a.kept, hasSound: a.hasSound, reading,
    madeHere: Boolean(g), generated: Boolean(g && recipe), seed, prompt,
    // the listing says it at once, before its parameters are read: no render, nothing that needs one
    madeElsewhere: a.generationId === null,
    opener: opener ? openerName : null, mover: mover ? moverName : null, carrier: Boolean(carrier), passes, voice: Boolean(follower),
    // each model a picture can open on (i2v), or a motion transfer be made with: the menus' submenus
    openers: openerChoices.map((c) => ({ label: c.name, note: c.last ? "used last" : c.ready ? undefined : "not ready", run: () => animate.mutate(c.id, said("Could not open it in a form")) })),
    movers: moverChoices.map((c) => ({ label: c.name, note: c.last ? "used last" : c.ready ? undefined : "not ready", run: () => transfer.mutate(c.id, said("Could not open it in a form")) })),
    comfyOnline: setup.data?.comfy.online ?? false,
    compare: "open it from a list",
    timelines: a.id ? timeline.items(a) : [],
    moves: a.id ? mutations.moves(a) : [],
    shares: a.id && (a.kind === "image" || a.kind === "video") ? channels.map((c) => ({ label: c.name, disabled: share.isPending, note: share.isPending ? "sending…" : undefined, run: () => share.mutate({ id: a.id, channel: c.id, name: c.name }) })) : [],
    queued: done && done.id === a.id ? { [done.action]: true } : undefined,
    busy: {
      "reuse-same": reuse.isPending, "reuse-new": reuse.isPending, variation: queued.isPending, i2v: animate.isPending, extend: carryOn.isPending, motion: transfer.isPending,
      "vary-subtle": queued.isPending, "vary-strong": queued.isPending, upscale: queued.isPending, face: queued.isPending, hand: queued.isPending, background: queued.isPending, inpaint: openTool.isPending, edit: openTool.isPending, outpaint: openTool.isPending,
      "mirror-h": media.mirror.isPending, "mirror-v": media.mirror.isPending, "save-frame": media.saveFrame.isPending, "extract-audio": media.takeSound.isPending, "remove-sound": media.silence.isPending, voice: follow.isPending,
      comfy: mutations.openInComfy.isPending,
    },
    ...more,
  });

  /** A file of a linked folder leaves its folder on the disk: asked first, as the viewer and a selection do. */
  const toBin = async () => {
    if (await askAboutDisk([a])) mutations.bin([a.id]);
  };
  const runs: Runs = {
    keep: () => mutations.keep([a.id], !a.kept),
    // saved under the one name rule of the app (the library's menu and the selection save the same way)
    download: () => saveAsset(a),
    rename: () => void mutations.renameIt(a),
    "reuse-same": () => g && reuse.sameSeed(g),
    "reuse-new": () => g && reuse.newSeed(g),
    variation: () => {
      const job = variationJob();
      if (job) queue("variation", job);
    },
    "vary-subtle": () => {
      const job = varyOf("vary-subtle");
      if (job) queue("vary-subtle", job);
    },
    "vary-strong": () => {
      const job = varyOf("vary-strong");
      if (job) queue("vary-strong", job);
    },
    i2v: () => animate.mutate(undefined, said("Could not open it in a form")),
    motion: () => transfer.mutate(undefined, said("Could not open it in a form")),
    extend: () => carryOn.mutate(undefined, said("Could not extend it")),
    upscale: () => quick("u"),
    face: () => quick("f"),
    hand: hands,
    background: () => quick("b"),
    inpaint: () => openPass("i"),
    edit: () => openPass("e"),
    outpaint: () => openPass("r"),
    "mirror-h": () => media.mirror.mutate("horizontal", said("Could not mirror it")),
    "mirror-v": () => media.mirror.mutate("vertical", said("Could not mirror it")),
    "save-frame": () => media.saveFrame.mutate(undefined, said("Could not save the frame")),
    "extract-audio": () => media.takeSound.mutate(undefined, said("Could not extract the audio")),
    "remove-sound": () => media.silence.mutate(undefined, said("Could not remove the sound")),
    voice: () => follow.mutate(undefined, said("Could not open it in a form")),
    // where the page has no clipboard for pictures (its LAN address over http) Copy the picture has no run, and is not drawn
    ...(a.kind === "image" && canCopyPicture() ? { "copy-image": () => mutations.copyImage(a) } : {}),
    "copy-seed": () => seed !== null && mutations.copySeed(seed),
    "copy-prompt": () => prompt && mutations.copyPrompt(prompt),
    comfy: () => mutations.openInComfy.mutate(a),
    bin: a.inBin ? () => mutations.restore([a.id]) : () => void toBin(),
    erase: () => void eraseNow(client, [a.id]),
  };

  /** The item's list in a place: its facts and overrides on top of what is known and done everywhere. */
  const list = (more: Partial<ItemFacts> = {}, overrides: Runs = {}, notes: Partial<Record<ActionId, string>> = {}) =>
    itemActions(facts(more), { ...runs, ...overrides }, notes, tunes);

  return { ...drafts, ...media, queued, quick, openPass, mutations, timeline, seed, prompt, facts, runs, list };
}
