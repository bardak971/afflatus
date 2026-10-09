import { useState } from "react";
import { RANDOM_SEED } from "@afflatus/core";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Clapperboard, Copy, Download, ExternalLink, Eye, Film, MoreHorizontal, Pencil, Plus, Search, Shuffle, SquareCheck, Star, Trash2, Undo2 } from "lucide-react";
import { useAddTo, useLast, useQueueVariation, useStartTimeline } from "./actions";
import { AddToTimeline } from "./AddToTimeline";
import { api, type Asset } from "./api";
import { askAboutDisk } from "./Confirm";
import { ContextMenu, useMenu, type MenuHead, type MenuItem } from "./ContextMenu";
import { formPlaces, useFormTarget } from "./formTarget";
import { useAsset, useDrafts, useFamilies, useRecipes, useSetup, useTimelines } from "./data";
import { saveAsset } from "./download";
import { useOpenNewDraft } from "./draft";
import { clock, when } from "./format";
import { useItemMutations } from "./itemMutations";
import { usedLast } from "./picker";
import { tileName } from "./screens/Library";

/**
 * The right-click menu of a library tile: what the viewer offers on the item, without opening it. Each
 * entry mirrors a button or a key of the viewer. What needs the item's generation parameters (Reuse,
 * Variation, Open in ComfyUI) is offered once they are read, which starts when the menu opens.
 */
export function useTileMenu({ onOpen, onSelect, into, first, compact, subject }: {
  onOpen(asset: Asset): void;
  /** The item the menu is for while it is not open at the pointer (the command bar lists its actions): its generation is read for it. */
  subject?: Asset | null;
  /** Inside an editor: what the Studio does with an item (i2v, reuse, timelines, projects) folds into one "More" submenu. */
  compact?: boolean;
  /** What the place the menu opens in does with the item, before everything else (the editor's library: add it to the timeline). */
  first?(asset: Asset): MenuItem[];
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
}) {
  const { menu, open, close } = useMenu<Asset>();
  const formTarget = useFormTarget((st) => st.target);
  const a = menu?.subject ?? subject ?? null;
  const detail = useAsset(a?.id ?? null);
  const { renameIt, keep, bin, restore, moveToItems, openInComfy, failed } = useItemMutations();
  const recipes = useRecipes();
  const setup = useSetup();
  const on = useFamilies().isOn;
  const drafts = useDrafts(Boolean(a));

  const g = detail.data?.generation ?? null;
  const recipe = g ? recipes.data?.recipes.find((r) => r.id === g.recipe) : undefined;
  const all = (recipes.data?.recipes ?? []).filter((r) => on(r.family));
  const opener = usedLast(
    all.filter((r) => r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start")),
    drafts.data?.items,
    (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready),
  );
  const toForm = useOpenNewDraft();
  const animate = useMutation({
    mutationFn: (asset: Asset) => {
      const slot = opener!.inputs.find((i) => i.type === "image" && i.role === "start")!;
      return api.createDraft({ recipe: opener!.id, forms: { [opener!.id]: { [slot.id]: asset.id } }, look: detail.data?.look ?? null });
    },
    onSuccess: toForm,
    onError: failed("Could not open it in a form"),
  });
  const again = useMutation({
    mutationFn: () => api.createDraft({ recipe: g!.recipe, forms: { [g!.recipe]: { ...g!.inputs, seed: RANDOM_SEED } } }),
    onSuccess: toForm,
    onError: failed("Could not reuse its parameters"),
  });
  const variation = useQueueVariation(into);
  const timelineMenu = useTimelineSubmenu();
  /** To the bin; a file of a linked folder leaves its folder on the disk, which is asked first (as the viewer and a selection do). */
  const toBin = async (asset: Asset) => {
    if (await askAboutDisk([asset])) bin.mutate(asset.id);
  };
  const items = (asset: Asset): MenuItem[] => {
    const reading = detail.isLoading;
    const studio: MenuItem[] = [
      ...(asset.kind === "image" && opener && !asset.inBin ? [{ label: "Image to video (i2v)", key: "M", icon: <Clapperboard size={14} />, note: opener.title, run: () => animate.mutate(asset) }] : []),
      { label: "Reuse parameters", key: "L", icon: <Copy size={14} />, disabled: reading || !g || !recipe, note: !reading && !g ? "not generated here" : undefined, run: () => again.mutate() },
      { label: "Variation", key: "V", icon: <Shuffle size={14} />, note: !reading && !g ? "not generated here" : "new seed, queued", disabled: reading || !g || !recipe || asset.inBin, run: () => recipe && g && variation.mutate({ recipe, stored: { ...g.inputs, seed: RANDOM_SEED }, label: "Variation" }) },
      { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: reading || !g || !(setup.data?.comfy.online ?? false), run: () => openInComfy.mutate(asset) },
      ...timelineMenu.items(asset),
      ...moveToItems(asset),
    ];
    const places = compact ? [] : formPlaces(formTarget, asset);
    return [
      ...(first?.(asset) ?? []),
      ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }, "—" as const] : []),
      { label: "Open", icon: <Eye size={14} />, run: () => onOpen(asset) },
      { label: asset.kept ? "Unkeep" : "Keep", key: "S", icon: <Star size={14} />, disabled: asset.inBin, run: () => keep.mutate({ id: asset.id, kept: !asset.kept }) },
      ...(onSelect ? [{ label: "Select", key: "Ctrl + Click", icon: <SquareCheck size={14} />, run: () => onSelect(asset) }] : []),
      ...(compact ? [] : ["—" as const, ...studio]),
      "—" as const,
      { label: "Rename…", icon: <Pencil size={14} />, run: () => void renameIt(asset) },
      { label: "Download", key: "D", icon: <Download size={14} />, run: () => saveAsset(asset) },
      asset.inBin
        ? { label: "Put back", icon: <Undo2 size={14} />, run: () => restore.mutate(asset.id) }
        : { label: "Move to the bin", key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => void toBin(asset) },
      ...(compact ? ["—" as const, { label: "More", icon: <MoreHorizontal size={14} />, note: "i2v, reuse, timelines, projects", items: studio.filter((it, i, all) => it !== "—" || (i > 0 && i < all.length - 1 && all[i - 1] !== "—")) }] : []),
    ];
  };

  const element = (
    <>
      {a && menu && <ContextMenu at={menu.at} label={`Actions on this ${a.kind}`} head={assetHead(a)} items={items(a)} onClose={close} />}
      {timelineMenu.element}
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

/**
 * The Timeline submenu, the same in every menu of an item (the library's tiles, the stage, the viewer): the
 * recent timelines of the project straight, one click adding the item at the end (the last one used first, on A);
 * any other through a dialog with a search and the folders; or a new timeline from it. Pictures and videos only.
 */
export function useTimelineSubmenu(opts: { onStarted?(): void } = {}) {
  const timelines = useTimelines();
  const last = useLast();
  const [adding, setAdding] = useState<Asset | null>(null);
  const [, go] = useLocation();
  const addTo = useAddTo();
  const start = useStartTimeline({ onSuccess: (t) => { opts.onStarted?.(); go(`/timelines/${t.id}`); } });
  const items = (asset: Asset): MenuItem[] => {
    if (asset.kind === "audio" || asset.inBin) return [];
    const recent = [...(timelines.data?.items ?? [])]
      .sort((x, y) => (x.id === last?.id ? -1 : y.id === last?.id ? 1 : y.updatedAt.localeCompare(x.updatedAt)))
      .slice(0, 5);
    const end = asset.kind === "image" ? "at the end, as a still" : "at the end";
    return [{
      label: "Timeline", icon: <Film size={14} />, note: last ? `last: ${last.name}` : undefined, items: [
        ...recent.map((t): MenuItem => ({
          label: `Add to ${t.name}`, key: t.id === last?.id ? "A" : undefined, icon: <Film size={14} />,
          note: t.id === last?.id ? `last used · ${end}` : `${t.clips} clip${t.clips === 1 ? "" : "s"} · ${when(t.updatedAt)}`,
          disabled: addTo.isPending, run: () => addTo.mutate({ asset, timeline: t }),
        })),
        ...(recent.length ? ["—" as const] : []),
        { label: recent.length ? "Another timeline…" : "Add to a timeline…", icon: <Search size={14} />, note: "search, by folder", run: () => setAdding(asset) },
        { label: "Start a timeline from it", key: "N", icon: <Plus size={14} />, note: asset.kind === "image" ? "clip 1 opens on this picture" : "clip 1 is this video", run: () => start.mutate(asset) },
      ],
    }];
  };
  const element = adding ? <AddToTimeline asset={adding} onClose={() => setAdding(null)} /> : null;
  // the keys of the viewer (N, A) do what the submenu does
  const startFrom = (asset: Asset) => start.mutate(asset);
  const addToLast = last ? (asset: Asset) => addTo.mutate({ asset, timeline: last }) : null;
  return { items, element, startFrom, addToLast };
}

/**
 * What a tile's menu offers besides the viewer's own actions, for the viewer's and the stage's menus: the open
 * form ("Use in this draft"), first; then ComfyUI, another project and a name of its own, before the bin.
 */
export function useItemExtras() {
  const formTarget = useFormTarget((st) => st.target);
  const setup = useSetup();
  const { renameIt, moveToItems, openInComfy } = useItemMutations();
  /** "Use in this draft", when a form is open and takes it. */
  const first = (asset: Asset): MenuItem[] => {
    const places = formPlaces(formTarget, asset);
    return places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }, "—"] : [];
  };
  /** ComfyUI (a render made here), another project, a name. */
  const more = (asset: Asset, generated: boolean): MenuItem[] => [
    ...(generated ? [{ label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: !(setup.data?.comfy.online ?? false), note: setup.data?.comfy.online ? undefined : "ComfyUI is offline", run: () => openInComfy.mutate(asset) }] : []),
    ...moveToItems(asset),
    { label: "Rename…", icon: <Pencil size={14} />, run: () => void renameIt(asset) },
  ];
  return { first, more };
}
