import { Plus, SquareCheck } from "lucide-react";
import type { Asset } from "./api";
import { ContextMenu, useMenu, type MenuHead, type MenuItem } from "./ContextMenu";
import { formPlaces, useFormTarget } from "./formTarget";
import { useAsset } from "./data";
import { clock } from "./format";
import { placeMenu, type ItemFacts, type Place } from "./itemActions";
import { NO_ASSET, useItemActions } from "./useItemActions";
import { askViewer, type ViewerAsk } from "./viewer/ask";
import { tileName } from "./screens/Library";

/**
 * The right-click menu of a library tile: the item's list (itemActions.tsx), the same as the viewer's, after what the
 * place does with the item (`first`, the open form's "Use in this draft", Select). Its keys show only where they act
 * (`place`). What needs the item's generation parameters (Reuse, Variation, the seed, ComfyUI) is offered once they
 * are read, which starts when the menu opens; until then those lines say "reading…". Trim, Compare and Details open
 * the viewer on the item with that tool.
 */
export function useTileMenu({ onOpen, onSelect, into, first, subject, place = "grid", form = true, listed = true, seed }: {
  onOpen(asset: Asset): void;
  /** The item the menu is for while it is not open at the pointer (the command bar lists its actions): its generation is read for it. */
  subject?: Asset | null;
  /** Where the menu opens: which keys act there. */
  place?: Place;
  /** "Use in this draft" when a form is open: not where the open form is not the Studio's (the timeline's media shelf). */
  form?: boolean;
  /** The viewer opens on the place's list (the arrows step through it, Compare works); not where it opens on the item alone. */
  listed?: boolean;
  /** The seed, when the place knows it before the item's parameters are read (a finished job of the queue). */
  seed?: number | null;
  /** What the place the menu opens in does with the item, before everything else (the editor's library: add it to the timeline). */
  first?(asset: Asset): MenuItem[];
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
}) {
  const { menu, open, close } = useMenu<Asset>();
  const formTarget = useFormTarget((st) => st.target);
  const subjectOf = menu?.subject ?? subject ?? null;
  const detail = useAsset(subjectOf?.id ?? null);
  const acts = useItemActions({
    asset: subjectOf ?? NO_ASSET, detail, enabled: Boolean(subjectOf), into, sayErrors: true,
    // a frame, a sound, a mirrored copy made from here: shown in the viewer, as the place opens an item
    onOpened: onOpen,
    // A and N act in the viewer, on the item open in it: shown where the keys are named (the stage, the command bar)
    timeline: { noKeys: place !== "stage" && place !== "command", noStartKey: place === "stage" },
  });
  const openWith = (asset: Asset, what: ViewerAsk) => {
    askViewer(asset.id, what);
    onOpen(asset);
  };
  const more: Partial<ItemFacts> = { compare: listed ? true : "open it from a list", ...(seed !== undefined && seed !== null && acts.seed === null ? { seed } : {}) };
  const items = (asset: Asset): MenuItem[] => {
    const item = acts.a.id === asset.id ? acts.a : asset;
    const list = acts.list(more, {
      open: () => onOpen(item),
      trim: () => openWith(item, "trim"),
      compare: () => openWith(item, "compare"),
      details: () => openWith(item, "details"),
      ...(seed !== undefined && seed !== null && acts.seed === null ? { "copy-seed": () => acts.mutations.copySeed(seed) } : {}),
    }, { "save-frame": "the first frame" });
    const places = form ? formPlaces(formTarget, item) : [];
    const own: MenuItem[] = [
      ...(first?.(item) ?? []),
      ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }] : []),
      ...(onSelect ? [{ label: "Select", key: "Ctrl+click", icon: <SquareCheck size={14} />, run: () => onSelect(item) }] : []),
    ];
    return placeMenu(own, list, place);
  };

  const element = (
    <>
      {subjectOf && menu && <ContextMenu at={menu.at} label={`Actions on this ${subjectOf.kind === "audio" ? "sound" : subjectOf.kind === "image" ? "picture" : "video"}`} head={assetHead(subjectOf)} items={items(subjectOf)} onClose={close} />}
      {acts.timeline.element}
    </>
  );
  return { open, element, items, reading: detail.isLoading };
}

const KIND_WORD = { image: "Picture", video: "Video", audio: "Sound" } as const;

/** The head of an item's menu: its picture, its name, "Video · 0:05 · Clip 3". */
export function assetHead(a: Asset): MenuHead {
  const length = a.kind !== "image" && a.durationMs !== null ? <span className="font-mono">{clock(a.durationMs)}</span> : null;
  return {
    title: tileName(a),
    // a sound has no picture
    thumb: a.kind === "audio" ? undefined : a.id,
    sub: <>{KIND_WORD[a.kind]}{length && <> · {length}</>}{a.clipOf && ` · Clip ${a.clipOf.clip}`}</>,
  };
}
