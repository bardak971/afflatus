import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Camera, Clapperboard, Download, FlipHorizontal2, Info, Music, Scissors, Shuffle, Star, Trash2, Undo2, Wand2 } from "lucide-react";
import { RANDOM_SEED } from "@afflatus/core";
import { useQueueVariation } from "../actions";
import { askAboutDisk } from "../Confirm";
import { api, type Asset } from "../api";
import { useAssetAction, type useAsset } from "../data";
import { saveAsset } from "../download";
import type { MenuItem } from "../ContextMenu";
import { OPS } from "./shared";
import { useMediaExtract } from "./useMediaExtract";
import { useNewDraftActions } from "./useNewDraftActions";

/** The pages of the list past what is loaded: whether there are more, whether one is being read, and reading the next. */
export interface ViewerMore {
  has: boolean;
  busy: boolean;
  load(): void;
}

/**
 * Everything the viewer does to the item: its mutations, the tools by key, the menus, and the item as it is
 * known. The new drafts it opens are `useNewDraftActions`; what a video gives besides itself (frames, its
 * sound, ranges) is `useMediaExtract`.
 */
export function useViewerActions({ asset, first, trailed, items, more, detail, into, inline, player, trim, setTrim, setInfo, onOpen, onClose, onOpened }: {
  /** The item shown: the end of the trail, or the one the viewer was opened on. */
  asset: Asset;
  /** The item the viewer was opened on, whose place in `items` the arrows step from. */
  first: Asset;
  /** "Made from" or "used to make" was followed: the arrows no longer step through the list. */
  trailed: boolean;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
  /** The list has more pages than `items` holds: the arrow past the last one reads the next page and steps on. */
  more?: ViewerMore;
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
  const { a, g, recipe, reuse, carrier, carryOn, opener, openerName, animate, toolFor, toolInput, openTool } = drafts;

  /** Queue something at once, and say so. */
  const queued = useQueueVariation(into);
  const quick = (key: string) => {
    const tool = toolFor(key);
    if (tool) queued.mutate({ recipe: tool, stored: toolInput(tool), label: OPS[key]!.label });
  };
  /** The item before or after in the list it was opened from. */
  const at = !trailed && items ? items.findIndex((x) => x.id === first.id) : -1;
  // past the last one loaded: the next page is read, and the step lands once it is here (`from` and its place then)
  const [awaiting, setAwaiting] = useState<{ from: string; index: number } | null>(null);
  const askedFor = useRef<Asset[] | undefined>(undefined);
  const move = (by: -1 | 1) => {
    const next = at >= 0 ? items![at + by] : undefined;
    setAwaiting(null);
    if (next) onOpen?.(next);
    else if (by === 1 && at >= 0 && more?.has && onOpen) {
      setAwaiting({ from: first.id, index: at });
      askedFor.current = items;
      if (!more.busy) more.load();
      return true;
    }
    return Boolean(next);
  };
  useEffect(() => {
    if (!awaiting || !items || more?.busy) return;
    const i = items.findIndex((x) => x.id === awaiting.from);
    // gone meanwhile (binned on the way): the one that took its place
    const next = i >= 0 ? items[i + 1] : items[awaiting.index];
    if (next) {
      setAwaiting(null);
      onOpen?.(next);
    } else if (!more?.has) setAwaiting(null);
    // the page landed elsewhere (a grouped list): one more
    else if (items !== askedFor.current) {
      askedFor.current = items;
      more.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, items, more?.busy, more?.has]);
  const toBin = async () => {
    // a file of a linked folder leaves its folder on the disk: asked first
    if (!(await askAboutDisk([a]))) return;
    bin.mutate(undefined);
    // on to the next one: sorting a batch is keep, bin, keep, bin
    if (!(move(1) || move(-1))) onClose();
  };
  // saved under the one name rule of the app (the library's menu and the selection save the same way)
  const download = () => saveAsset(a);

  // ---- the menus: every action the buttons and keys offer. In the bin only D (and the arrows, X) still act, so
  // the menus there drop Keep and what makes something new, take the reuse keys off, and end on Put back (no key).
  const sameAgain = (): MenuItem[] => (g && recipe ? [
    { label: "Variation: same parameters, new seed", key: a.inBin ? undefined : "V", icon: <Shuffle size={14} />, run: () => queued.mutate({ recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" }) },
    { label: "Reuse · same seed", key: a.inBin ? undefined : "L", icon: <Wand2 size={14} />, note: "in the form", run: () => reuse.sameSeed(g) },
    { label: "Reuse · new seed", key: a.inBin ? undefined : "Shift + L", icon: <Wand2 size={14} />, note: "in the form", run: () => reuse.newSeed(g) },
  ] : []);
  const keepItem = (): MenuItem[] => (a.inBin ? [] : [{ label: a.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, run: () => keep.mutate(!a.kept) }]);
  /** The menu's last entry: out of the bin, or into it. */
  const binItem = (): MenuItem => (a.inBin
    ? { label: "Put back", icon: <Undo2 size={14} />, run: () => restore.mutate(undefined) }
    : { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin() });
  const videoItems = (): MenuItem[] => [
    ...keepItem(),
    { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
    ...sameAgain(),
    "—" as const,
    ...(!a.inBin ? [{ label: "Save this frame as an image", key: "G", icon: <Camera size={14} />, run: () => media.saveFrame.mutate() }] : []),
    ...(!a.inBin ? [{ label: trim ? "Close Trim" : "Trim: pick a range", key: "T", icon: <Scissors size={14} />, run: () => setTrim(!trim) }] : []),
    ...(carrier && !a.inBin ? [{ label: "Extend: a new clip that carries on", key: "C", icon: <Clapperboard size={14} />, run: () => carryOn.mutate() }] : []),
    ...(a.hasSound && !a.inBin ? [{ label: "Extract audio", icon: <Music size={14} />, note: "its sound as a file of its own", run: () => media.takeSound.mutate() }] : []),
    "—" as const,
    binItem(),
  ];
  /** The picture's menu: every action its buttons and keys offer. */
  const imageItems = (): MenuItem[] => {
    const now = a.inBin ? [] : ["u", "f", "b"].flatMap((k): MenuItem[] => (toolFor(k) ? [{ label: OPS[k]!.label, key: k.toUpperCase(), run: () => quick(k) }] : []));
    const forms = a.inBin ? [] : ["i", "e", "r"].flatMap((k): MenuItem[] => { const tool = toolFor(k); return tool ? [{ label: tool.title, key: k.toUpperCase(), run: () => openTool.mutate(tool.id) }] : []; });
    return [
      ...keepItem(),
      { label: "Download the file", key: "D", icon: <Download size={14} />, run: download },
      ...sameAgain(),
      ...(!g && !a.inBin ? [{ label: "PNG info", key: "P", icon: <Info size={14} />, run: () => setInfo(true) }] : []),
      "—" as const,
      ...(opener && !a.inBin ? [{ label: "Image to video (i2v)", key: "M", icon: <Clapperboard size={14} />, note: openerName, run: () => animate.mutate() }] : []),
      ...(now.length ? [{ label: "Queue now", icon: <Wand2 size={14} />, note: "with its own parameters", items: now }] : []),
      ...(forms.length ? [{ label: "Open in a form", icon: <Wand2 size={14} />, note: "a new draft", items: forms }] : []),
      ...(!a.inBin ? [{ label: "Mirror", icon: <FlipHorizontal2 size={14} />, note: "a mirrored copy", items: [
        { label: "Left and right", run: () => media.mirror.mutate("horizontal") },
        { label: "Top and bottom", run: () => media.mirror.mutate("vertical") },
      ] }] : []),
      "—" as const,
      binItem(),
    ];
  };

  return { ...drafts, ...media, first, keep, restore, leave, queued, quick, at, more: Boolean(more?.has), move, toBin, download, videoItems, imageItems };
}

/** What `useViewerActions` gives: handed whole to the parts of the viewer. */
export type ViewerActions = ReturnType<typeof useViewerActions>;
