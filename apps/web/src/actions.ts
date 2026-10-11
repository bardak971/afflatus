import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { projectForNew } from "./project";
import { api, type Asset, type Opened } from "./api";
import { useTimelines } from "./data";
import { useSayFailed } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";
import { timelineOf, type TimelineOf } from "./timelineOf";

/** What the viewer, a tile's menu and the workflows list do alike with an item: the one body each, the words their own. */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The site of a host name, roughly (no public-suffix list): an address as it is, a name by its last two labels. */
const siteOf = (host: string) => (/^[\d.]+$|^\[/.test(host) ? host : host.split(".").slice(-2).join("."));
/**
 * The address a ComfyUI page is opened at. ComfyUI answers 403 to a page opened from another site (its guard
 * against requests forged by other websites), and to the browser localhost and 127.0.0.1 are two sites: with
 * both on this machine, the address takes the page's own host name. `crossSite`: still another site (ComfyUI on
 * another machine), so it will likely refuse unless it runs with --enable-cors-header.
 */
function comfyHref(url: string): { href: string; crossSite: boolean } {
  try {
    const u = new URL(url);
    const page = window.location.hostname;
    if (LOOPBACK.has(u.hostname) && LOOPBACK.has(page)) u.hostname = page;
    return { href: u.toString(), crossSite: siteOf(u.hostname) !== siteOf(page) };
  } catch {
    return { href: url, crossSite: false };
  }
}

/**
 * Something opened in ComfyUI's editor: a result's graph built again, a workflow written into its
 * folder. The tab is opened before the request, or the browser would block it as a pop-up; it is
 * closed again when the request fails.
 */
export function useOpenInComfy<T>(request: (v: T) => Promise<Opened>, opts: { onSuccess?(r: Opened, v: T): void; onError?(err: Error, v: T): void } = {}) {
  const say = useBanners((b) => b.push);
  return useMutation({
    mutationFn: async (v: T) => {
      const tab = window.open("", "_blank");
      // the tab is ComfyUI's: it gets no hold on this page
      if (tab) tab.opener = null;
      try {
        const r = await request(v);
        const to = comfyHref(r.url);
        if (tab) tab.location.href = to.href;
        if (to.crossSite) say({ id: `comfy-site:${Date.now()}`, tone: "bad", title: "ComfyUI may refuse that tab (403)", text: "ComfyUI only opens pages asked for by its own site, and Afflatus is on another one. Start ComfyUI with --enable-cors-header to allow it, or open ComfyUI from the address bar.", href: "/settings", go: "Open settings" });
        return r;
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
    onSuccess: opts.onSuccess,
    onError: opts.onError,
  });
}

/** The timeline an item was last added to, per project (the Inbox under "none"): "Add to <it>" with one key goes there. */
const useLastTimeline = create<{ by: Record<string, { id: string; name: string }>; set(project: string, t: { id: string; name: string }): void }>()(
  persist((set) => ({ by: {}, set: (project, t) => set((s) => ({ by: { ...s.by, [project]: t } })) }), { name: "afflatus.last-timeline" }),
);
const projectKey = () => projectForNew() ?? "none";
/** The timeline last added to in the project the rail looks at, or null. */
export const useLast = () => {
  const kept = useLastTimeline((s) => s.by[projectKey()] ?? null);
  const timelines = useTimelines();
  if (!kept) return null;
  // a timeline deleted since is no place to add to; one renamed since is named as it is now
  const live = timelines.data?.items.find((t) => t.id === kept.id);
  if (timelines.data && !live) return null;
  return live ? { id: live.id, name: live.name } : kept;
};
const remember = (target: { id: string; name: string }) => useLastTimeline.getState().set(projectKey(), target);

type Target = { id: string; name: string };

/**
 * A timeline made of items, or items put at the end of one (timelineOf.ts): `of` says what from the mutation's
 * value (it may first bring files into the library). The timeline is remembered as the last one added to and the
 * timelines are read again, whichever place asked.
 */
export function useTimelineOf<V>(of: (v: V) => TimelineOf | Promise<TimelineOf>, opts: { onSuccess?(target: Target, v: V): void; onError?(err: Error, v: V): void } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (v: V) => timelineOf(await of(v), { create: () => api.createTimeline(), add: api.addClip }),
    onSuccess: (target: Target, v: V) => {
      remember(target);
      void client.invalidateQueries({ queryKey: queryKeys.timelines.all() });
      opts.onSuccess?.(target, v);
    },
    onError: opts.onError,
  });
}

/** An item put at the end of a timeline: one of the project's (by id), or a new one (null). Gives the timeline it went to. */
export function useAddToTimeline(asset: Asset, opts: { onSuccess?(target: Target): void } = {}) {
  const timelines = useTimelines();
  return useTimelineOf(
    (timeline: string | null): TimelineOf => ({
      assets: [asset],
      into: timeline ? { id: timeline, name: timelines.data?.items.find((t) => t.id === timeline)?.name ?? "the timeline" } : null,
    }),
    { onSuccess: (target) => opts.onSuccess?.(target) },
  );
}

/**
 * A timeline started from one item, in the project the rail looks at: a video is its clip 1; a picture is the
 * first frame of a clip 1 to render, its form open on it. Then the editor.
 */
export function useStartTimeline(opts: { onSuccess?(target: Target): void } = {}) {
  const failed = useSayFailed({ id: "timeline" });
  return useTimelineOf((asset: Asset): TimelineOf => ({ assets: [asset], firstAsClip: true }), {
    onSuccess: (target) => opts.onSuccess?.(target),
    onError: failed("Could not start the timeline"),
  });
}

/** One item to the end of a given timeline (a menu's recent timelines); remembered as the last one, said in a banner. */
export function useAddTo() {
  const say = useBanners((b) => b.push);
  const failed = useSayFailed({ id: "add" });
  return useTimelineOf((v: { asset: Asset; timeline: Target }): TimelineOf => ({ assets: [v.asset], into: v.timeline }), {
    onSuccess: (timeline, { asset }) => say({ id: `add:${Date.now()}`, tone: "good", title: `Added to ${timeline.name}`, text: asset.kind === "image" ? "At the end, as a still." : "At the end.", href: `/timelines/${timeline.id}`, go: "Open the timeline" }),
    onError: failed("Could not add it"),
  });
}

/** A new timeline of several items, in the order given: videos as clips, pictures as stills (as the Add dialog makes them). Then the editor. */
export function useMakeTimelineOf(opts: { onSuccess?(target: Target): void } = {}) {
  const failed = useSayFailed({ id: "timeline" });
  return useTimelineOf((assets: Asset[]): TimelineOf => ({ assets }), {
    onSuccess: (target) => opts.onSuccess?.(target),
    onError: failed("Could not start the timeline"),
  });
}
