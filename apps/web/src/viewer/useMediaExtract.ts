import type { RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Range } from "../Trim";
import { api, type Asset } from "../api";
import { useBanners } from "../store";

/**
 * What a video gives besides itself: the frame it is paused on, its sound, its shots,
 * and ranges of it as new videos (copied, split out, removed, slowed). Frames and sounds open in the viewer
 * once made (`onOpened`); ranges are jobs of the queue, said in a banner.
 */
export function useMediaExtract({ asset, trim, player, onOpened }: { asset: Asset; trim: boolean; player: RefObject<HTMLVideoElement | null>; onOpened(asset: Asset): void }) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  // where the video cuts between shots: read when Trim opens, kept
  const scenes = useQuery({ queryKey: ["scenes", asset.id], queryFn: () => api.scenes(asset.id), enabled: trim && asset.kind === "video", staleTime: Infinity });
  const everyScene = useMutation({
    mutationFn: async (v: { cuts: number[]; crf: number }) => {
      const edges = [0, ...v.cuts, asset.durationMs ?? 0];
      for (let i = 0; i + 1 < edges.length; i++) {
        if (edges[i + 1]! - edges[i]! < 200) continue;
        await api.range(asset.id, { startMs: edges[i]!, endMs: edges[i + 1]!, action: "copy", crf: v.crf });
      }
    },
  });
  // (the library refreshes on the server's own word, its `library` event)
  const saveFrame = useMutation({ mutationFn: () => api.frame(asset.id, Math.round((player.current?.currentTime ?? 0) * 1000)), onSuccess: onOpened });
  const takeSound = useMutation({ mutationFn: () => api.takeSound(asset.id), onSuccess: onOpened });
  // a picture mirrored: the copy opens in the viewer, beside the original in its folder
  const mirror = useMutation({ mutationFn: (axis: "horizontal" | "vertical") => api.mirror(asset.id, axis), onSuccess: onOpened });
  // the range as new videos: a job of the queue; the library shows them when it is done
  const cutRange = useMutation({
    mutationFn: (v: { range: Range; action: "copy" | "split" | "remove" | "slow"; crf: number; factor?: 2 | 4 }) => api.range(asset.id, { startMs: Math.round(v.range.startMs), endMs: Math.round(v.range.endMs), action: v.action, crf: v.crf, factor: v.factor }),
    onSuccess: (r, v) => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      // Trim stays open: the next action may follow on the same range
      if (v.action === "slow") {
        say({ id: `cut:${Date.now()}`, tone: "good", title: `Slowing the range ×${v.factor ?? 2}`, text: `${r.engine === "rife" ? "RIFE on the GPU, through the queue." : "ffmpeg's motion interpolation on the processor: slow, minutes for a few seconds. For RIFE on the GPU, put a RIFE model in ComfyUI's models/frame_interpolation folder with the frame interpolation nodes."} The new video, its sound slowed with it, shows in the library when it is done.`, href: "/queue", go: "Open queue" });
        return;
      }
      say({ id: `cut:${Date.now()}`, tone: "good", title: v.action === "copy" ? "Copying the range to your library" : v.action === "split" ? "Splitting the video" : "Removing the range", text: `In the queue; it needs no GPU. The new video${v.action === "split" ? "s show" : " shows"} in the library when it is done${v.action === "copy" ? "" : "; this one goes to the bin then"}.`, href: "/queue", go: "Open queue" });
    },
  });
  return { scenes, everyScene, saveFrame, takeSound, cutRange, mirror };
}
