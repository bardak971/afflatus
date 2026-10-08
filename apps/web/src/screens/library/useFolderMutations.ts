import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { projectForNew } from "../../project";
import type { Place } from "../../store";

/**
 * What the folder panel changes. The server says each change with a "library" event, which reads the
 * folders and the lists again (live.ts): nothing is invalidated here but what that event does not cover.
 */
export function useFolderMutations({ selected, onPlace }: { selected: string | null; onPlace(p: Place): void }) {
  const client = useQueryClient();
  const create = useMutation({ mutationFn: (v: { name: string; parent: string | null }) => api.createFolder(v.name, v.parent, v.parent ? undefined : projectForNew()) });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.editFolder(v.id, { name: v.name }) });
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
  /** Files from the computer dropped on a folder: imported straight into it (pictures, videos and sounds; the rest is left to the drop tray). */
  const bring = useMutation({
    mutationFn: async (v: { files: File[]; folder: string | null }) => {
      const media = v.files.filter((f) => /^(image|video|audio)\//.test(f.type));
      for (const f of media) await api.upload(f, v.folder ? { folder: v.folder } : {});
      return { count: media.length, folder: v.folder };
    },
    onSuccess: (r) => {
      if (r.count) onPlace(r.folder ? { type: "folder", id: r.folder } : { type: "unfiled" });
    },
  });
  // the bin, emptied now instead of waiting a week: asked twice, it cannot be undone. Clips of timelines may have played what it held
  const empty = useMutation({ mutationFn: api.emptyBin, onSuccess: () => client.invalidateQueries({ queryKey: ["timelines"] }) });
  const error = create.error ?? rename.error ?? remove.error ?? move.error ?? bring.error ?? link.error ?? look.error ?? empty.error ?? moveTimelines.error;
  return { create, rename, remove, moveTimelines, move, link, look, bring, empty, error };
}
