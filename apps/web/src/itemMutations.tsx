import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, Folder, FolderKanban, Inbox, Music, Plus, Search } from "lucide-react";
import { useAddTo, useLast, useOpenInComfy, useStartTimeline } from "./actions";
import { AddToTimeline } from "./AddToTimeline";
import { api, type Asset, type TimelineBrief } from "./api";
import { useAssetChange } from "./assetChange";
import { askText } from "./Confirm";
import type { MenuItem } from "./ContextMenu";
import { useFolders, useProjects, useTimelines } from "./data";
import { when } from "./format";
import { tree } from "./screens/library/tree";
import { copyText } from "./secureContext";
import { useSayFailed } from "./sayFailed";
import { useBanners } from "./store";

/**
 * What the menus of an item change on it (a tile's, the viewer's, the stage's), the one body each. Keep, rename,
 * the bin, put back and Move to show at once and are sent behind (assetChange.tsx: a refusal puts them back and says
 * why, with Retry; a move or a bin says so with Undo). What else fails is said in a banner.
 */
export function useItemMutations() {
  const client = useQueryClient();
  const failed = useSayFailed();
  const say = useBanners((b) => b.push);
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  const folders = useFolders().data?.items ?? [];
  const change = useAssetChange();
  /** A name of the user's own, asked for in a box; the library shows it and the search goes by it. */
  const rename = (id: string, name: string) => void change({ kind: "rename", ids: [id], name });
  const renameIt = async (of: Asset) => {
    const name = await askText({ title: "Rename", value: of.name, placeholder: "A name for it", yes: "Rename" });
    if (name !== null && name !== of.name) rename(of.id, name);
  };
  const keep = (ids: string[], kept: boolean) => void change({ kind: "keep", ids, kept });
  const bin = (ids: string[]) => void change({ kind: "bin", ids });
  const restore = (ids: string[]) => void change({ kind: "restore", ids });
  const moveTo = (ids: string[], folder: string | null) => void change({ kind: "move", ids, folder });
  // a folder made on the spot, the item moved into it at once
  const makeFolder = useMutation({
    mutationFn: async (v: { ids: string[]; name: string; parent: string | null; project: string | null }) => {
      const folder = await api.createFolder(v.name, v.parent, v.project);
      await api.moveAssets(v.ids, folder.id);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["projects"] }),
    onError: failed("Could not make the folder"),
  });
  /**
   * The Move to submenu: each project with its root folder and its folders (a project with none is one line), then
   * the Inbox; where it is now is off. `ids`: several items moved together (the item's own when left out).
   */
  const moves = (asset: Pick<Asset, "id" | "folderId">, ids: string[] = [asset.id]): MenuItem[] => {
    const here = (folder: string | null) => ids.length === 1 && asset.folderId === folder;
    const go = (folder: string | null) => () => moveTo(ids, folder);
    return [
      ...projects.map((p): MenuItem => {
        // the folders under its root folder, in reading order; a folder inside another shows where it is
        const inside = tree(folders.filter((f) => f.projectId === p.id && f.id !== p.folderId));
        const pathOf = (id: string | null): string[] => {
          const f = folders.find((x) => x.id === id);
          return !f || f.id === p.folderId ? [] : [...pathOf(f.parentId), f.name];
        };
        const root: MenuItem = { label: inside.length ? "Root folder" : p.name, icon: <FolderKanban size={14} />, note: inside.length ? undefined : "its root folder", disabled: here(p.folderId), run: go(p.folderId) };
        if (!inside.length) return root;
        return { label: p.name, icon: <FolderKanban size={14} />, items: [
          root,
          ...inside.map((f): MenuItem => ({ label: pathOf(f.id).join(" › "), icon: <Folder size={14} />, note: `${f.count}`, disabled: here(f.id), run: go(f.id) })),
        ] };
      }),
      ...(projects.length ? ["—" as const] : []),
      { label: "The Inbox", icon: <Inbox size={14} />, note: "out of every project", disabled: here(null), run: go(null) },
    ];
  };
  /** A new folder, asked for by name, in the item's project (under its root folder) or the Inbox; the item goes into it. */
  const newFolderFor = async (asset: Pick<Asset, "id" | "folderId">) => {
    const name = await askText({ title: "New folder", value: "", placeholder: "Folder name", yes: "Create and move" });
    if (!name?.trim()) return;
    const at = folders.find((f) => f.id === asset.folderId);
    const project = at?.projectId ? projects.find((p) => p.id === at.projectId) : undefined;
    makeFolder.mutate({ ids: [asset.id], name: name.trim(), parent: project?.folderId ?? null, project: project?.id ?? null });
  };
  const openInComfy = useOpenInComfy((asset: Asset) => api.openRender(asset.id), {
    onSuccess: (r) => { if (!r.direct) say({ id: `menu:${Date.now()}`, tone: "good", title: "Saved in ComfyUI", text: `${r.path}: open the Workflows sidebar there (key W) and pick it under "afflatus".`, href: "/settings", go: "Open settings" }); },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Could not open in ComfyUI", text: err.message, href: "/settings", go: "Open settings" }),
  });
  /** The seed on the clipboard, said in a banner: where the menu was, nothing shows the figure. */
  const copySeed = (seed: number) => void copyText(String(seed)).then(
    () => say({ id: `seed:${Date.now()}`, tone: "good", title: `Seed ${seed} copied` }),
    (err: Error) => failed("Could not copy the seed")(err),
  );
  return { rename, renameIt, keep, bin, restore, moves, moveTo, newFolderFor, openInComfy, copySeed, failed };
}

/**
 * The Timeline submenu, the same in every list of an item: the recent timelines of the project straight, one click
 * adding the item at the end (the last one used first, on A); any other through a dialog with a search and the folders;
 * or a new timeline from it. A sound becomes a timeline's music instead (the call the timeline's music row makes).
 */
export function useTimelineSubmenu(opts: {
  onStarted?(): void;
  /** Where N does something else (it folds the form in Studio: the grid, the inline viewer on the stage): "Start a timeline" shows no key. */
  noStartKey?: boolean;
  /** Where neither A nor N reaches the item (a tile's menu): no key at all. */
  noKeys?: boolean;
} = {}) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const timelines = useTimelines();
  const last = useLast();
  const [adding, setAdding] = useState<Asset | null>(null);
  const [, go] = useLocation();
  const addTo = useAddTo();
  const start = useStartTimeline({ onSuccess: (t) => { opts.onStarted?.(); go(`/timelines/${t.id}`); } });
  const music = useMutation({
    mutationFn: (v: { asset: Asset; timeline: TimelineBrief }) => api.editTimeline(v.timeline.id, { music: { asset: v.asset.id } }),
    onSuccess: (_t, v) => {
      void client.invalidateQueries({ queryKey: ["timelines"] });
      say({ id: `music:${Date.now()}`, tone: "good", title: `${v.asset.name || "The sound"} is the music of ${v.timeline.name}`, href: `/timelines/${v.timeline.id}`, go: "Open the timeline" });
    },
    onError: (err) => say({ id: `music:${Date.now()}`, tone: "bad", title: "Could not set the music", text: err.message, href: "/timelines", go: "Open timelines" }),
  });
  const recent = (n: number) => [...(timelines.data?.items ?? [])]
    .sort((x, y) => (x.id === last?.id ? -1 : y.id === last?.id ? 1 : y.updatedAt.localeCompare(x.updatedAt)))
    .slice(0, n);
  const clipsNote = (t: TimelineBrief) => `${t.clips} clip${t.clips === 1 ? "" : "s"} · ${when(t.updatedAt)}`;
  /** The submenu's lines (the list's "Timeline" holds them). */
  const items = (asset: Asset): MenuItem[] => {
    if (asset.kind === "audio") {
      return recent(8).map((t): MenuItem => ({ label: `Music of ${t.name}`, icon: <Music size={14} />, note: clipsNote(t), disabled: music.isPending, run: () => music.mutate({ asset, timeline: t }) }));
    }
    const list = recent(5);
    const end = asset.kind === "image" ? "at the end, as a still" : "at the end";
    return [
      ...list.map((t): MenuItem => ({
        label: `Add to ${t.name}`, key: t.id === last?.id && !opts.noKeys ? "A" : undefined, icon: <Film size={14} />,
        note: t.id === last?.id ? `last used · ${end}` : clipsNote(t),
        disabled: addTo.isPending, run: () => addTo.mutate({ asset, timeline: t }),
      })),
      ...(list.length ? ["—" as const] : []),
      { label: list.length ? "Another timeline…" : "Add to a timeline…", icon: <Search size={14} />, note: "search, by folder", run: () => setAdding(asset) },
      { label: "Start a timeline from it", key: opts.noStartKey || opts.noKeys ? undefined : "N", icon: <Plus size={14} />, note: asset.kind === "image" ? "clip 1 opens on this picture" : "clip 1 is this video", run: () => start.mutate(asset) },
    ];
  };
  const element = adding ? <AddToTimeline asset={adding} onClose={() => setAdding(null)} /> : null;
  // the keys of the viewer (N, A) do what the submenu does
  const startFrom = (asset: Asset) => start.mutate(asset);
  const addToLast = last ? (asset: Asset) => addTo.mutate({ asset, timeline: last }) : null;
  return { items, element, startFrom, addToLast };
}
