import type { Dispatch, RefObject, SetStateAction } from "react";
import { Camera, Clapperboard, Download, Music, Scissors, Shuffle, Star, Trash2, Wand2 } from "lucide-react";
import { RANDOM_SEED } from "@afflatus/core";
import { useQueueVariation } from "../actions";
import { askAboutDisk } from "../Confirm";
import { api, fileUrl, type Asset } from "../api";
import { useAssetAction, type useAsset } from "../data";
import type { MenuItem } from "../ContextMenu";
import { FORMATS, OPS } from "./shared";
import { useMediaExtract } from "./useMediaExtract";
import { useNewDraftActions } from "./useNewDraftActions";

/**
 * Everything the viewer does to the item: its mutations, the tools by key, the menus, and the item as it is
 * known. The new drafts it opens are `useNewDraftActions`; what a video gives besides itself (frames, its
 * sound, ranges) is `useMediaExtract`.
 */
export function useViewerActions({ asset, first, trailed, items, detail, into, inline, player, trim, setTrim, setInfo, onOpen, onClose, onOpened }: {
  /** The item shown: the end of the trail, or the one the viewer was opened on. */
  asset: Asset;
  /** The item the viewer was opened on, whose place in `items` the arrows step from. */
  first: Asset;
  /** "Made from" or "used to make" was followed: the arrows no longer step through the list. */
  trailed: boolean;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
  detail: ReturnType<typeof useAsset>;
  /** What is queued from here belongs to this draft and lands in this folder. */
  into?: { draft?: string; folder?: string };
  /** Drawn in place: the viewer stays when a form opens. */
  inline?: boolean;
  player: RefObject<HTMLVideoElement | null>;
  trim: boolean;
  setTrim: Dispatch<SetStateAction<boolean>>;
  setInfo: Dispatch<SetStateAction<boolean>>;
  onOpen?(asset: Asset): void;
  onClose(): void;
  /** An item made here (a frame, a sound), shown in its turn. */
  onOpened(asset: Asset): void;
}) {
  const keep = useAssetAction((kept: boolean) => api.keep(asset.id, kept));
  const bin = useAssetAction(() => api.bin(asset.id));
  const restore = useAssetAction(() => api.restore(asset.id));
  /** Over the screen, it steps aside when one of its actions opens a form: the form is what is looked at next. */
  const leave = () => {
    if (!inline) onClose();
  };
  const drafts = useNewDraftActions({ asset, detail, leave });
  const media = useMediaExtract({ asset, trim, player, onOpened });
  const { a, g, recipe, again, carrier, carryOn, opener, openerName, animate, toolFor, toolInput, openTool } = drafts;

  /** Queue something at once, and say so. */
  const queued = useQueueVariation(into);
  const quick = (key: string) => {
    const tool = toolFor(key);
    if (tool) queued.mutate({ recipe: tool, stored: toolInput(tool), label: OPS[key]!.label });
  };
  /** The item before or after in the list it was opened from. */
  const at = !trailed && items ? items.findIndex((x) => x.id === first.id) : -1;
  const move = (by: -1 | 1) => {
    const next = at >= 0 ? items![at + by] : undefined;
    if (next) onOpen?.(next);
    return Boolean(next);
  };
  const toBin = async () => {
    // a file of a linked folder leaves its folder on the disk: asked first
    if (!(await askAboutDisk([a]))) return;
    bin.mutate(undefined);
    // on to the next one: sorting a batch is keep, bin, keep, bin
    if (!(move(1) || move(-1))) onClose();
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = fileUrl(asset.id);
    link.download = a.name || `${asset.id}.${(FORMATS[a.mime] ?? "bin").toLowerCase()}`;
    link.click();
  };

  // ---- the menus: every action the buttons and keys offer
  const sameAgain = (): MenuItem[] => (g && recipe ? [
    { label: "Variation: same parameters, new seed", key: "V", icon: <Shuffle size={14} />, run: () => queued.mutate({ recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" }) },
    { label: "Reuse parameters in the form", key: "L", icon: <Wand2 size={14} />, run: () => again.mutate(g) },
  ] : []);
  const videoItems = (): MenuItem[] => [
    { label: a.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, run: () => keep.mutate(!a.kept) },
    { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
    ...sameAgain(),
    "—" as const,
    { label: "Save this frame as an image", key: "G", icon: <Camera size={14} />, run: () => media.saveFrame.mutate() },
    ...(!a.inBin ? [{ label: trim ? "Close Trim" : "Trim: pick a range", key: "T", icon: <Scissors size={14} />, run: () => setTrim(!trim) }] : []),
    ...(carrier ? [{ label: "Extend: a new clip that carries on", key: "C", icon: <Clapperboard size={14} />, run: () => carryOn.mutate() }] : []),
    ...(a.hasSound && !a.inBin ? [{ label: "Extract audio", icon: <Music size={14} />, note: "its sound as a file of its own", run: () => media.takeSound.mutate() }] : []),
    "—" as const,
    { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin() },
  ];
  /** The picture's menu: every action its buttons and keys offer. */
  const imageItems = (): MenuItem[] => {
    const now = a.inBin ? [] : ["u", "f", "b"].flatMap((k): MenuItem[] => (toolFor(k) ? [{ label: OPS[k]!.label, key: k.toUpperCase(), run: () => quick(k) }] : []));
    const forms = a.inBin ? [] : ["i", "e", "r"].flatMap((k): MenuItem[] => { const tool = toolFor(k); return tool ? [{ label: tool.title, key: k.toUpperCase(), run: () => openTool.mutate(tool.id) }] : []; });
    return [
      { label: a.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, run: () => keep.mutate(!a.kept) },
      { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
      ...sameAgain(),
      ...(!g ? [{ label: "Details", key: "P", run: () => setInfo(true) }] : []),
      "—" as const,
      ...(opener && !a.inBin ? [{ label: `Make a video of it (${openerName})`, key: "M", icon: <Clapperboard size={14} />, run: () => animate.mutate() }] : []),
      ...(now.length ? [{ label: "Queue now", icon: <Wand2 size={14} />, note: "with its own parameters", items: now }] : []),
      ...(forms.length ? [{ label: "Open in a form", icon: <Wand2 size={14} />, note: "a new draft", items: forms }] : []),
      "—" as const,
      { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin() },
    ];
  };

  return { ...drafts, ...media, keep, restore, leave, queued, quick, at, move, toBin, download, videoItems, imageItems };
}

/** What `useViewerActions` gives: handed whole to the parts of the viewer. */
export type ViewerActions = ReturnType<typeof useViewerActions>;
