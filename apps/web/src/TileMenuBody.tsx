import type { ReactNode } from "react";
import { Plus, SquareCheck } from "lucide-react";
import type { Asset } from "./api";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { formPlaces, useFormTarget } from "./formTarget";
import { useAsset } from "./data";
import { placeMenu, type ItemFacts } from "./itemActions";
import { assetHead, type TileMenuOptions } from "./TileMenu";
import { useItemActions } from "./useItemActions";
import { askViewer, type ViewerAsk } from "./viewer/ask";

/**
 * A tile's menu once it was first opened (TileMenu.tsx): the item's actions, worked on `acting` (the item open in the
 * menu, else the one it was last open on), and the menu drawn while `menu` is open. Stays mounted after: what a line
 * started (a timeline's dialog) outlives the menu.
 */
export function TileMenuBody({ onOpen, onSelect, into, first, place = "grid", form = true, listed = true, seed, omit, menu, acting, onClose }: TileMenuOptions & {
  menu: { at: Parameters<typeof ContextMenu>[0]["at"]; subject: Asset } | null;
  acting: Asset;
  onClose(): void;
}): ReactNode {
  const formTarget = useFormTarget((st) => st.target);
  const detail = useAsset(acting.id);
  // a picture made for a Motion transfer draft goes back to it from here
  const acts = useItemActions({
    asset: acting, detail, enabled: true, into, sayErrors: true,
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
    }, { "save-frame": "the first frame" }).filter((x) => !omit?.includes(x.id));
    const places = form ? formPlaces(formTarget, item) : [];
    const own: MenuItem[] = [
      ...(first?.(item) ?? []),
      ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }] : []),
      ...(onSelect ? [{ label: "Select", key: "Ctrl+click", icon: <SquareCheck size={14} />, run: () => onSelect(item) }] : []),
    ];
    return placeMenu(own, list, place);
  };

  return (
    <>
      {menu && <ContextMenu at={menu.at} label={`Actions on this ${menu.subject.kind === "audio" ? "sound" : menu.subject.kind === "image" ? "picture" : "video"}`} head={assetHead(menu.subject)} items={items(menu.subject)} onClose={onClose} />}
      {acts.timeline.element}
    </>
  );
}
