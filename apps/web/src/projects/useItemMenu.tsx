import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Film, FolderInput, LayoutGrid, Plus, Star, StarOff, Trash2 } from "lucide-react";
import { api, type Asset, type TimelineBrief } from "../api";
import type { MenuItem } from "../ContextMenu";
import { useTimelines } from "../data";
import { saveAsset } from "../download";
import { when } from "../format";
import { useItemMutations } from "../itemMutations";
import { useBanners } from "../store";
import { useTileMenu } from "../TileMenu";
import { queryKeys } from "../queryKeys";

/**
 * The menus of the panel's items: one item gets the item's list (useTileMenu, as every tile), after the panel's own
 * section (Show in the Studio); its Timeline puts a video at the end of a timeline and makes a sound a timeline's
 * music. Several picked items get one menu that acts on them all, in the same order, with only what works on many.
 */
export function useItemMenu({ onView, onStudio }: { onView(asset: Asset): void; onStudio(asset: Asset): void }) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const timelines = useTimelines();
  const { keep, renameIt } = useItemMutations();
  const recent = (): TimelineBrief[] => [...(timelines.data?.items ?? [])].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 8);
  const timelineNote = (t: TimelineBrief) => `${t.clips} clip${t.clips === 1 ? "" : "s"} · ${when(t.updatedAt)}`;

  const extras = (a: Asset): MenuItem[] => [
    { label: "Show in the Studio", icon: <LayoutGrid size={14} />, note: "in its folder", run: () => onStudio(a) },
  ];
  // the viewer opens on the item alone here: Compare says so
  const tile = useTileMenu({ onOpen: onView, first: extras, place: "projects", listed: false });

  const addAll = useMutation({
    mutationFn: async (v: { assets: Asset[]; timeline: { id: string; name: string } | null }): Promise<{ id: string; name: string }> => {
      const t: { id: string; name: string } = v.timeline ?? (await api.createTimeline().then((x) => ({ id: x.id, name: x.name })));
      for (const a of v.assets) await api.addClip(t.id, { asset: a.id, ...(a.kind === "image" && !v.timeline && a === v.assets[0] ? { as: "clip" as const } : {}) });
      return t;
    },
    onSuccess: (t, v) => {
      void client.invalidateQueries({ queryKey: queryKeys.timelines.all() });
      say({ id: `tree-add:${Date.now()}`, tone: "good", title: `${v.assets.length} added to ${t.name}`, text: "At the end, in the order they show.", href: `/timelines/${t.id}`, go: "Open the timeline" });
    },
    onError: (err) => say({ id: `tree-add:${Date.now()}`, tone: "bad", title: "Could not add them", text: err.message, href: "/timelines", go: "Open timelines" }),
  });
  /** The menu of several picked items: the item's list's order (itemActions.tsx), only what works on many. */
  const many = (assets: Asset[], more: { moveTo: MenuItem[]; bin(): void }): MenuItem[] => {
    const ids = assets.map((a) => a.id);
    const playable = assets.filter((a) => a.kind !== "audio" && !a.inBin);
    return [
      { label: `Keep ${assets.length}`, key: "S", icon: <Star size={14} />, run: () => keep(ids, true) },
      { label: `Unkeep ${assets.length}`, icon: <StarOff size={14} />, run: () => keep(ids, false) },
      { label: `Download ${assets.length}`, icon: <Download size={14} />, note: "one file each", run: () => assets.forEach((a) => saveAsset(a)) },
      "—",
      {
        label: "Timeline", icon: <Film size={14} />, disabled: !playable.length, note: !playable.length ? "sounds go one by one, as music" : playable.length < assets.length ? `${playable.length} of them: no sounds` : "at the end, in order",
        items: [
          ...recent().map((t): MenuItem => ({ label: `Add to ${t.name}`, icon: <Film size={14} />, note: timelineNote(t), run: () => addAll.mutate({ assets: playable, timeline: t }) })),
          ...(recent().length ? ["—" as const] : []),
          { label: "Start a timeline from them", icon: <Plus size={14} />, run: () => addAll.mutate({ assets: playable, timeline: null }) },
        ],
      },
      { label: "Move to", icon: <FolderInput size={14} />, items: more.moveTo },
      "—",
      { label: `Move ${assets.length} to the bin`, key: "Del", icon: <Trash2 size={14} />, danger: true, run: more.bin },
    ];
  };
  return { open: tile.open, element: tile.element, many, keep, renameIt };
}
