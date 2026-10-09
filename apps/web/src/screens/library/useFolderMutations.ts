import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { bringFiles } from "../../bringFiles";
import { askAboutDisk } from "../../Confirm";
import { projectForNew } from "../../project";
import { useBanners, type Place } from "../../store";

/**
 * What the folder panel changes. The server says each change with a "library" event, which reads the
 * folders and the lists again (live.ts): nothing is invalidated here but what that event does not cover.
 */
export function useFolderMutations({ selected, onPlace }: { selected: string | null; onPlace(p: Place): void }) {
  const client = useQueryClient();
  const create = useMutation({ mutationFn: (v: { name: string; parent: string | null }) => api.createFolder(v.name, v.parent, v.parent ? undefined : projectForNew()) });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editFolder(v.id, { name: v.name }) });
  // a folder taken to another project: inside its root folder (with what is in it), or out of every project to the top
  const say = useBanners((b) => b.push);
  const toProject = useMutation({
    mutationFn: (v: { id: string; name: string; project: { id: string; name: string; folderId: string | null } | null }) =>
      api.editFolder(v.id, v.project?.folderId ? { parentId: v.project.folderId } : { parentId: null, project: v.project?.id ?? null }),
    onSuccess: (_r, v) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      say({ id: `folder-moved:${v.id}:${Date.now()}`, tone: "good", title: `${v.name} moved to ${v.project ? v.project.name : "the Inbox"}`, text: "With the folders and items inside it.", href: "/", go: "Open it", act: () => onPlace({ type: "folder", id: v.id }) });
    },
    onError: (err, v) => say({ id: `folder-moved:${v.id}:${Date.now()}`, tone: "bad", title: `${v.name} could not be moved`, text: err.message, href: "/", go: "Open the library" }),
  });
  const remove = useMutation({
    mutationFn: api.deleteFolder,
    onSuccess: (_r, id) => {
      if (selected === id) onPlace({ type: "all" });
    },
  });
  // timelines dropped on a folder: listed there, and their renders land there
  const moveTimelines = useMutation({
    mutationFn: (v: { ids: string[]; folder: string | null }) => Promise.all(v.ids.map((id) => api.editTimeline(id, { folder: v.folder }))),
    onSuccess: () => client.invalidateQueries({ queryKey: ["timelines"] }),
  });
  const move = useMutation({ mutationFn: (v: { asset: string; folder: string | null }) => api.moveAssets(v.asset.split(",").filter(Boolean), v.folder) });
  const link = useMutation({
    mutationFn: (path: string) => api.linkFolder(path),
    onSuccess: async (made) => {
      // the list of folders first: a folder that is not in it yet is no place to go to
      await client.invalidateQueries({ queryKey: ["folders"] });
      onPlace({ type: "folder", id: made.id });
    },
  });
  const look = useMutation({ mutationFn: api.scanFolder });
  /** Files from the computer dropped on a folder (or on No folder): brought in as the Projects panel does it (bringFiles.ts). */
  const bring = useMutation({
    mutationFn: (v: { files: File[]; folders: number; folder: { id: string; name: string; path: string | null } | null }) =>
      bringFiles(v.files, {
        name: v.folder?.name ?? "No folder",
        folders: v.folders,
        onDisk: Boolean(v.folder?.path),
        landing: async () => ({ folder: v.folder?.id ?? null, made: false }),
        say,
        done: (added, at) => {
          if (added) onPlace(at.folder ? { type: "folder", id: at.folder } : { type: "unfiled" });
        },
      }),
  });
  /** Items of the library dropped on the Bin: to the bin, once asked when some are files of a linked folder (as the Projects panel's Bin does). */
  const toBin = useMutation({
    mutationFn: async (ids: string[]) => {
      const items = await Promise.all(ids.map((id) => api.asset(id)));
      if (!(await askAboutDisk(items))) return;
      await api.bulkAssets(ids, "bin");
      const one = items.length === 1;
      say({ id: `folder-bin:${Date.now()}`, tone: "good", title: `${one ? items[0]!.shownName || items[0]!.name || "1 item" : `${items.length} items`} moved to the bin`, text: "For a week they can be restored from it.", href: "/", go: "Open the bin", act: () => onPlace({ type: "bin" }) });
    },
  });
  // the bin, emptied now instead of waiting a week: asked twice, it cannot be undone. Clips of timelines may have played what it held
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: () => client.invalidateQueries({ queryKey: ["timelines"] }) });
  const error = create.error ?? rename.error ?? toProject.error ?? remove.error ?? move.error ?? bring.error ?? toBin.error ?? link.error ?? look.error ?? empty.error ?? moveTimelines.error;
  return { create, rename, toProject, remove, moveTimelines, move, link, look, bring, toBin, empty, error };
}
