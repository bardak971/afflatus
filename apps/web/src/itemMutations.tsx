import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { useOpenInComfy } from "./actions";
import { api, type Asset } from "./api";
import { askText } from "./Confirm";
import type { MenuItem } from "./ContextMenu";
import { useProjects } from "./data";
import { useBanners } from "./store";

/** A banner for an action of a menu that failed: said, with the way to the library. */
export function useSayFailed() {
  const say = useBanners((b) => b.push);
  return (title: string) => (err: Error) => say({ id: `failed:${Date.now()}`, tone: "bad", title, text: err.message, href: "/", go: "Open the library" });
}

/**
 * What the menus of an item change on it (a tile's, the viewer's, the stage's), the one body each. The
 * server says each change with a "library" event (live.ts reads the lists again), except a keep of one
 * item, which is read again here. What fails is said in a banner.
 */
export function useItemMutations() {
  const client = useQueryClient();
  const failed = useSayFailed();
  const say = useBanners((b) => b.push);
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  // a name of the user's own, asked for in a box; the library shows it and the search goes by it
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.renameAsset(v.id, v.name), onError: failed("Could not rename it") });
  const renameIt = async (of: Asset) => {
    const name = await askText({ title: "Rename", value: of.name, placeholder: "A name for it", yes: "Rename" });
    if (name !== null && name !== of.name) rename.mutate({ id: of.id, name });
  };
  const keep = useMutation({ mutationFn: (v: { id: string; kept: boolean }) => api.keep(v.id, v.kept), onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }), onError: failed("Could not keep it") });
  const bin = useMutation({ mutationFn: (id: string) => api.bin(id), onError: failed("Could not move it to the bin") });
  const restore = useMutation({ mutationFn: (id: string) => api.restore(id), onError: failed("Could not put it back") });
  // the projects, to move an item into another's root folder (or out of every project, into the Inbox); their counts are not under "assets"
  const moveTo = useMutation({
    mutationFn: (v: { ids: string[]; folder: string | null }) => api.moveAssets(v.ids, v.folder),
    onSuccess: () => client.invalidateQueries({ queryKey: ["projects"] }),
    onError: failed("Could not move it"),
  });
  /** "Move to" → a project's root folder, or the Inbox; nothing when there is no project, or the item is in the bin. */
  const moveToItems = (asset: Asset): MenuItem[] =>
    projects.length && !asset.inBin
      ? [{ label: "Move to", icon: <FolderKanban size={14} />, note: "another project", items: [
          ...projects.map((p): MenuItem => ({ label: p.name, icon: <FolderKanban size={14} />, note: "its root folder", disabled: asset.folderId === p.folderId, run: () => moveTo.mutate({ ids: [asset.id], folder: p.folderId }) })),
          { label: "The Inbox", icon: <FolderKanban size={14} />, note: "out of every project", disabled: asset.folderId === null, run: () => moveTo.mutate({ ids: [asset.id], folder: null }) },
        ] }]
      : [];
  const openInComfy = useOpenInComfy((asset: Asset) => api.openRender(asset.id), {
    onSuccess: (r) => { if (!r.direct) say({ id: `menu:${Date.now()}`, tone: "good", title: "Saved in ComfyUI", text: `${r.path}: open the Workflows sidebar there (key W) and pick it under "afflatus".`, href: "/settings", go: "Open settings" }); },
    onError: (err) => say({ id: `menu:${Date.now()}`, tone: "bad", title: "Could not open in ComfyUI", text: err.message, href: "/settings", go: "Open settings" }),
  });
  return { renameIt, keep, bin, restore, moveToItems, openInComfy, failed };
}
