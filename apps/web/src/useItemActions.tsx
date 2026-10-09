import { useRef, type RefObject } from "react";
import { RANDOM_SEED, typedSeed } from "@afflatus/core";
import { useQueueVariation } from "./actions";
import type { Asset } from "./api";
import { askAboutDisk } from "./Confirm";
import { useSetup, type useAsset } from "./data";
import { saveAsset } from "./download";
import { itemActions, PASS_KEYS, type ActionId, type ItemFacts, type Runs } from "./itemActions";
import { useItemMutations, useTimelineSubmenu } from "./itemMutations";
import { OPS } from "./viewer/shared";
import { useMediaExtract } from "./viewer/useMediaExtract";
import { useNewDraftActions } from "./viewer/useNewDraftActions";

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
  const { a, g, recipe, reuse, carrier, carryOn, opener, openerName, animate, follower, follow, toolFor, toolInput, openTool } = drafts;
  const said = (title: string) => (sayErrors ? { onError: mutations.failed(title) } : undefined);

  /** A pass queued at once with the picture's parameters (Upscale, Face detailer, Remove background). */
  const quick = (key: string) => {
    const tool = toolFor(key);
    if (tool) queued.mutate({ recipe: tool, stored: toolInput(tool), label: OPS[key]!.label });
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
    opener: opener ? openerName : null, carrier: Boolean(carrier), passes, voice: Boolean(follower),
    comfyOnline: setup.data?.comfy.online ?? false,
    compare: "open it from a list",
    timelines: a.id ? timeline.items(a) : [],
    moves: a.id ? mutations.moves(a) : [],
    busy: {
      "reuse-same": reuse.isPending, "reuse-new": reuse.isPending, variation: queued.isPending, i2v: animate.isPending, extend: carryOn.isPending,
      upscale: queued.isPending, face: queued.isPending, background: queued.isPending, inpaint: openTool.isPending, edit: openTool.isPending, outpaint: openTool.isPending,
      "mirror-h": media.mirror.isPending, "mirror-v": media.mirror.isPending, "save-frame": media.saveFrame.isPending, "extract-audio": media.takeSound.isPending, voice: follow.isPending,
      comfy: mutations.openInComfy.isPending,
    },
    ...more,
  });

  /** A file of a linked folder leaves its folder on the disk: asked first, as the viewer and a selection do. */
  const toBin = async () => {
    if (await askAboutDisk([a])) mutations.bin.mutate(a.id);
  };
  const runs: Runs = {
    keep: () => mutations.keep.mutate({ id: a.id, kept: !a.kept }),
    // saved under the one name rule of the app (the library's menu and the selection save the same way)
    download: () => saveAsset(a),
    rename: () => void mutations.renameIt(a),
    "reuse-same": () => g && reuse.sameSeed(g),
    "reuse-new": () => g && reuse.newSeed(g),
    variation: () => g && recipe && queued.mutate({ recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" }),
    i2v: () => animate.mutate(undefined, said("Could not open it in a form")),
    extend: () => carryOn.mutate(undefined, said("Could not extend it")),
    upscale: () => quick("u"),
    face: () => quick("f"),
    background: () => quick("b"),
    inpaint: () => openPass("i"),
    edit: () => openPass("e"),
    outpaint: () => openPass("r"),
    "mirror-h": () => media.mirror.mutate("horizontal", said("Could not mirror it")),
    "mirror-v": () => media.mirror.mutate("vertical", said("Could not mirror it")),
    "save-frame": () => media.saveFrame.mutate(undefined, said("Could not save the frame")),
    "extract-audio": () => media.takeSound.mutate(undefined, said("Could not extract the audio")),
    voice: () => follow.mutate(undefined, said("Could not open it in a form")),
    "copy-seed": () => seed !== null && mutations.copySeed(seed),
    comfy: () => mutations.openInComfy.mutate(a),
    bin: a.inBin ? () => mutations.restore.mutate(a.id) : () => void toBin(),
  };

  /** The item's list in a place: its facts and overrides on top of what is known and done everywhere. */
  const list = (more: Partial<ItemFacts> = {}, overrides: Runs = {}, notes: Partial<Record<ActionId, string>> = {}) =>
    itemActions(facts(more), { ...runs, ...overrides }, notes);

  return { ...drafts, ...media, queued, quick, openPass, mutations, timeline, seed, facts, runs, list };
}
