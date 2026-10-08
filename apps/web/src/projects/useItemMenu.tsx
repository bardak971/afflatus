import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, FolderInput, LayoutGrid, Music, Plus, Star, StarOff, Trash2 } from "lucide-react";
import { useAddTo, useStartTimeline } from "../actions";
import { api, type Asset, type TimelineBrief } from "../api";
import type { MenuItem } from "../ContextMenu";
import { useTimelines } from "../data";
import { when } from "../format";
import { useItemMutations } from "../itemMutations";
import { useBanners } from "../store";
import { useTileMenu } from "../TileMenu";

/**
 * The menus of the panel's items: one item gets the library tile's own menu (useTileMenu), the panel's
 * extras first (Show in the Studio, a video as a clip, a sound as music); several picked items get one
 * menu that acts on them all, in order.
 */
export function useItemMenu({ onView, onStudio }: { onView(asset: Asset): void; onStudio(asset: Asset): void }) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const timelines = useTimelines();
  const addTo = useAddTo();
  const start = useStartTimeline({ onSuccess: (t) => say({ id: `tree-start:${Date.now()}`, tone: "good", title: `${t.name} started`, text: "Its first clip is this video.", href: `/timelines/${t.id}`, go: "Open the timeline" }) });
  const { keep, renameIt } = useItemMutations();
  const recent = (): TimelineBrief[] => [...(timelines.data?.items ?? [])].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 8);
  const timelineNote = (t: TimelineBrief) => `${t.clips} clip${t.clips === 1 ? "" : "s"} · ${when(t.updatedAt)}`;

  // a sound as a timeline's music: the call the timeline's music row makes
  const music = useMutation({
    mutationFn: (v: { asset: Asset; timeline: TimelineBrief }) => api.editTimeline(v.timeline.id, { music: { asset: v.asset.id } }),
    onSuccess: (_t, v) => {
      void client.invalidateQueries({ queryKey: ["timelines"] });
      say({ id: `tree-music:${Date.now()}`, tone: "good", title: `${v.asset.name || "The sound"} is the music of ${v.timeline.name}`, href: `/timelines/${v.timeline.id}`, go: "Open the timeline" });
    },
    onError: (err) => say({ id: `tree-music:${Date.now()}`, tone: "bad", title: "Could not set the music", text: err.message, href: "/timelines", go: "Open timelines" }),
  });

  const extras = (a: Asset): MenuItem[] => [
    { label: "Show in the Studio", icon: <LayoutGrid size={14} />, note: "in its folder", run: () => onStudio(a) },
    ...(a.kind === "video" && !a.inBin
      ? [{
          label: "Use as a clip in", icon: <Film size={14} />, note: "at the end",
          items: [
            ...recent().map((t): MenuItem => ({ label: t.name, icon: <Film size={14} />, note: timelineNote(t), disabled: addTo.isPending, run: () => addTo.mutate({ asset: a, timeline: t }) })),
            ...(recent().length ? ["—" as const] : []),
            { label: "New timeline", icon: <Plus size={14} />, note: "clip 1 is this video", run: () => start.mutate(a) },
          ],
        }]
      : []),
    ...(a.kind === "audio" && !a.inBin
      ? [{
          label: "Use as music in", icon: <Music size={14} />, disabled: !recent().length, note: recent().length ? undefined : "no timeline yet",
          items: recent().map((t): MenuItem => ({ label: t.name, icon: <Film size={14} />, note: timelineNote(t), run: () => music.mutate({ asset: a, timeline: t }) })),
        }]
      : []),
    "—",
  ];
  const tile = useTileMenu({ onOpen: onView, first: extras });

  // several picked items, in the order they show
  const bulk = useMutation({
    mutationFn: (v: { ids: string[]; action: "keep" | "unkeep" }) => api.bulkAssets(v.ids, v.action),
    onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }),
    onError: (err) => say({ id: `tree-bulk:${Date.now()}`, tone: "bad", title: "Could not change them", text: err.message, href: "/", go: "Open the library" }),
  });
  const addAll = useMutation({
    mutationFn: async (v: { assets: Asset[]; timeline: { id: string; name: string } | null }): Promise<{ id: string; name: string }> => {
      const t: { id: string; name: string } = v.timeline ?? (await api.createTimeline().then((x) => ({ id: x.id, name: x.name })));
      for (const a of v.assets) await api.addClip(t.id, { asset: a.id, ...(a.kind === "image" && !v.timeline && a === v.assets[0] ? { as: "clip" as const } : {}) });
      return t;
    },
    onSuccess: (t, v) => {
      void client.invalidateQueries({ queryKey: ["timelines"] });
      say({ id: `tree-add:${Date.now()}`, tone: "good", title: `${v.assets.length} added to ${t.name}`, text: "At the end, in the order they show.", href: `/timelines/${t.id}`, go: "Open the timeline" });
    },
    onError: (err) => say({ id: `tree-add:${Date.now()}`, tone: "bad", title: "Could not add them", text: err.message, href: "/timelines", go: "Open timelines" }),
  });
  const many = (assets: Asset[], more: { moveTo: MenuItem[]; bin(): void }): MenuItem[] => {
    const ids = assets.map((a) => a.id);
    const playable = assets.filter((a) => a.kind !== "audio" && !a.inBin);
    return [
      { label: `Keep ${assets.length}`, key: "S", icon: <Star size={14} />, disabled: bulk.isPending, run: () => bulk.mutate({ ids, action: "keep" }) },
      { label: `Unkeep ${assets.length}`, icon: <StarOff size={14} />, disabled: bulk.isPending, run: () => bulk.mutate({ ids, action: "unkeep" }) },
      { label: "Move to", icon: <FolderInput size={14} />, items: more.moveTo },
      {
        label: "Add to a timeline", icon: <Film size={14} />, disabled: !playable.length, note: playable.length < assets.length ? `${playable.length} of them: no sounds` : "at the end, in order",
        items: [
          ...recent().map((t): MenuItem => ({ label: t.name, icon: <Film size={14} />, note: timelineNote(t), run: () => addAll.mutate({ assets: playable, timeline: t }) })),
          ...(recent().length ? ["—" as const] : []),
          { label: "New timeline", icon: <Plus size={14} />, run: () => addAll.mutate({ assets: playable, timeline: null }) },
        ],
      },
      "—",
      { label: `Move ${assets.length} to the bin`, key: "Del", icon: <Trash2 size={14} />, danger: true, run: more.bin },
    ];
  };
  return { open: tile.open, element: tile.element, many, keep, renameIt };
}
