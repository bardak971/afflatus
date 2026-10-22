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
import { itemActions, PASS_KEYS, type ActionId, type ItemFacts, type Runs } from "./itemActions";
import { useItemMutations, useTimelineSubmenu } from "./itemMutations";
import { useBanners } from "./store";
import { handsOf, OPS } from "./viewer/shared";
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
  const { a, g, recipe, reuse, carrier, carryOn, opener, openerName, animate, mover, moverName, transfer, openerChoices, moverChoices, follower, follow, toolFor, toolInput, openTool } = drafts;
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

  /** A pass queued at once with the picture's parameters (Upscale, Face refine, Hand refine, Remove background). */
  const quick = (key: string) => {
    const tool = toolFor(key);
    const action = (Object.keys(PASS_KEYS) as ActionId[]).find((id) => PASS_KEYS[id] === key);
    if (tool && action) queue(action, { recipe: tool, stored: toolInput(tool), label: OPS[key]!.label, from: a.id });
  };
  /**
   * The face detailer on the hand detector, on the values the recipe starts on for hands (denoise, crop factor, a
   * prompt about hands); the picture's negative prompt and model carried as for the face. A ComfyUI without the
   * detector is told where to get it rather than handed a face pass.
   */
  const hands = () => {
    const tool = toolFor("h");
    const way = tool && handsOf(tool);
    if (!tool || !way) return;
    const offered = setup.data?.recipes.find((x) => x.id === tool.id)?.options[way.input.id] ?? [];
    const file = offered.find((o) => new RegExp(way.match, "i").test(o));
    // offline, nothing is listed: the queue says ComfyUI does not answer, which is the reason
    if (!file && setup.data?.comfy.online) {
      say({ id: `queued:${Date.now()}`, tone: "bad", title: "Hand refine could not be queued", text: "The hand detector is not installed: Settings → Models → Image tools has it (one click).", href: "/settings/models", go: "Open settings" });
      return;
    }
    queue("hand", { recipe: tool, stored: { ...toolInput(tool), ...way.values, ...(file ? { [way.input.id]: file } : {}) }, label: OPS.h!.label, from: a.id });
  };
  /** A pass that opens a form with the picture in place (Inpaint, Edit, Outpaint). */
  const openPass = (key: string) => {
    const tool = toolFor(key);
    if (tool) openTool.mutate(tool.id, said(`Could not open ${OPS[key]!.label}`));
  };
  const seed = typedSeed(g?.resolved.seed);
  const reading = enabled && Boolean(asset.id) && detail.data?.id !== asset.id && detail.isFetching;
  const passes = Object.fromEntries(Object.entries(PASS_KEYS).flatMap(([id, k]) => {
    const tool = toolFor(k!);
    return tool ? [[id, tool.title]] : [];
  })) as Partial<Record<ActionId, string>>;

  /** What the list is made from, for the item; `more`: what the place knows (Compare, Trim open, its seed…). */
  const facts = (more: Partial<ItemFacts> = {}): ItemFacts => ({
    kind: a.kind, inBin: a.inBin, kept: a.kept, hasSound: a.hasSound, reading,
    madeHere: Boolean(g), generated: Boolean(g && recipe), seed,
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
      upscale: queued.isPending, face: queued.isPending, hand: queued.isPending, background: queued.isPending, inpaint: openTool.isPending, edit: openTool.isPending, outpaint: openTool.isPending,
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
    variation: () => g && recipe && queue("variation", { recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" }),
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
    "copy-seed": () => seed !== null && mutations.copySeed(seed),
    comfy: () => mutations.openInComfy.mutate(a),
    bin: a.inBin ? () => mutations.restore([a.id]) : () => void toBin(),
    erase: () => void eraseNow(client, [a.id]),
  };

  /** The item's list in a place: its facts and overrides on top of what is known and done everywhere. */
  const list = (more: Partial<ItemFacts> = {}, overrides: Runs = {}, notes: Partial<Record<ActionId, string>> = {}) =>
    itemActions(facts(more), { ...runs, ...overrides }, notes);

  return { ...drafts, ...media, queued, quick, openPass, mutations, timeline, seed, facts, runs, list };
}
