import { useEffect, useRef, useState, type RefObject } from "react";
import { askAboutDisk } from "../Confirm";
import type { Asset } from "../api";
import type { useAsset } from "../data";
import { saveAsset } from "../download";
import type { ActionId, ItemFacts, Runs } from "../itemActions";
import { useItemActions } from "../useItemActions";

/** The pages of the list past what is loaded: whether there are more, whether one is being read, and reading the next. */
export interface ViewerMore {
  has: boolean;
  busy: boolean;
  load(): void;
}

/**
 * Everything the viewer does to the item: the item's list (useItemActions, the same as every other place's), the
 * steps through the list it was opened from, and the item as it is known.
 */
export function useViewerActions({ asset, first, trailed, items, more, detail, into, inline, player, trim, onOpen, onClose, onOpened }: {
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
  onOpen?(asset: Asset): void;
  onClose(): void;
  /** An item made here (a frame, a sound), shown in its turn. */
  onOpened(asset: Asset): void;
}) {
  /** Over the screen, it steps aside when one of its actions opens a form: the form is what is looked at next. */
  const leave = () => {
    if (!inline) onClose();
  };
  // what every list of an item does (useItemActions), on the item shown: its frame is the player's, a form it opens steps the viewer aside
  const core = useItemActions({ asset, detail, leave, onOpened, into, player, trim, timeline: { onStarted: onClose, noStartKey: inline } });
  const { a, queued, quick, mutations } = core;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- more is a new object at every render; what it says is listed instead
  }, [awaiting, items, more?.busy, more?.has]);
  const toBin = async () => {
    // a file of a linked folder leaves its folder on the disk: asked first
    if (!(await askAboutDisk([a]))) return;
    // it leaves the list on screen at once (assetChange.tsx), just after this step is taken from where it was
    mutations.bin([a.id]);
    // on to the next one: sorting a batch is keep, bin, keep, bin
    if (!(move(1) || move(-1))) onClose();
  };
  // saved under the one name rule of the app (the library's menu and the selection save the same way)
  const download = () => saveAsset(a);

  /**
   * The item's list (itemActions.tsx) as the viewer does it: Keep and the bin on the item shown (the bin steps on to
   * the next one); `facts` and `overrides` are Viewer.tsx's own (Open, Trim, Compare, Details, the name).
   */
  const list = (facts: Partial<ItemFacts> = {}, overrides: Runs = {}, notes: Partial<Record<ActionId, string>> = {}) => core.list(facts, {
    bin: a.inBin ? () => mutations.restore([a.id]) : () => void toBin(),
    ...overrides,
  }, notes);

  return { ...core, first, leave, queued, quick, at, more: Boolean(more?.has), move, toBin, download, list };
}

/** What `useViewerActions` gives: handed whole to the parts of the viewer. */
export type ViewerActions = ReturnType<typeof useViewerActions>;
