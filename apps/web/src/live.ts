import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ProgressUpdate, QueueStatus, SystemLoad } from "./api";
import { HISTORY, LIBRARY_KEYS, RENDER_KEYS } from "./data";
import { endedSince, mergeProgress, notifyTag, throttle } from "./liveState";
import { useBanners, useNotify, useSystem } from "./store";

/** The version this page was built as (vite.config.ts), "dev" from the sources: what the server's hello is held against. */
export const BUILD_VERSION = __AFFLATUS_VERSION__;

const parse = (ev: Event): unknown => {
  try {
    return JSON.parse((ev as MessageEvent<string>).data);
  } catch {
    return null;
  }
};

/**
 * Whether this tab is the one that shows the notifications. With several tabs open, the first one holds a
 * lock for as long as it is open, and the next takes it over when it closes. Without locks (a page served
 * over plain http from another machine), every tab says it, and the per-job tag folds the copies into one.
 */
function useNotifier(): { current: boolean } {
  const me = useRef(typeof navigator === "undefined" || !navigator.locks);
  useEffect(() => {
    if (me.current) return;
    const stop = new AbortController();
    navigator.locks
      .request("afflatus.notify", { signal: stop.signal }, () => {
        me.current = true;
        // held until the tab goes
        return new Promise<void>((done) => stop.signal.addEventListener("abort", () => done()));
      })
      .catch(() => {});
    return () => stop.abort();
  }, []);
  return me;
}

const say = (title: string, body: string, tag: string) => {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body, tag });
};

/** Read again every query under each of these keys that is on screen; the others are only marked stale. */
const refetch = (client: QueryClient, keys: ReadonlyArray<readonly string[]>) => {
  for (const queryKey of keys) void client.invalidateQueries({ queryKey, refetchType: "active" });
};

/**
 * One event stream for the whole app. The server says what changed; the matching queries refetch.
 * Nothing polls: an idle app makes no requests.
 */
export function useLiveEvents(): void {
  const client = useQueryClient();
  const notifier = useNotifier();
  useEffect(() => {
    const source = new EventSource("/api/events");
    const on = (key: string) => () => refetch(client, [[key]]);

    // the queue, and the library, are read again at most once a second, with one last read after the last
    // event: a render reporting every step, or a folder of a thousand files coming in, costs a read a second
    const readQueue = throttle(() => void client.invalidateQueries({ queryKey: ["queue"], exact: true }), 1000);
    const readLibrary = throttle(() => refetch(client, LIBRARY_KEYS), 1000);
    source.addEventListener("queue", readQueue);
    source.addEventListener("library", readLibrary);

    source.addEventListener("progress", (ev) => {
      // with the job's figures in the event, the running job is changed in place: nothing is fetched
      const merged = mergeProgress(client.getQueryData<QueueStatus>(["queue"]), parse(ev) as Partial<ProgressUpdate> | null);
      if (merged) client.setQueryData<QueueStatus>(["queue"], merged);
      else readQueue();
    });

    // a job that ended, seen in the queue as it is read: the history and the render times are read again,
    // and what was asked to be told is told (a render that finished, the queue running empty)
    let seen: Set<string> | null = null;
    let busy = false;
    const unwatch = client.getQueryCache().subscribe((e) => {
      // a read of the queue, not a change made in place (a progress event, a new order)
      if (e.type !== "updated" || e.action.type !== "success" || e.action.manual || e.query.queryKey.length !== 1 || e.query.queryKey[0] !== "queue") return;
      const q = e.query.state.data as QueueStatus | undefined;
      if (!q) return;
      const first = seen === null;
      const now = endedSince(seen, q);
      seen = now.seen;
      const working = Boolean(q.running) || q.waiting.length > 0;
      if (now.ended.length) refetch(client, [HISTORY, ...RENDER_KEYS]);
      if (!first && notifier.current) {
        const { whenEmpty, eachRender } = useNotify.getState();
        for (const j of now.ended) if (eachRender && j.status !== "cancelled" && j.kind !== "load") say(j.status === "done" ? "Finished" : "Failed", j.label, notifyTag(j.id));
        if (whenEmpty && busy && !working) say("The queue is empty", "Everything that was waiting is done.", "afflatus:empty");
      }
      busy = working;
    });

    source.addEventListener("models", on("model-info"));
    source.addEventListener("timeline", on("timelines"));
    source.addEventListener("entities", on("entities"));
    source.addEventListener("downloads", on("downloads"));
    // ComfyUI has a file it did not have: what is ready may have changed
    source.addEventListener("setup", on("setup"));
    source.addEventListener("system", (ev) => {
      const data = parse(ev) as { load: SystemLoad | null } | null;
      if (data) useSystem.getState().set(data.load);
    });
    // the first hello is the page opening: everything was just read. A later one is a reconnect, after which
    // anything may have changed; and a server of another version means this page is out of date
    let greeted = false;
    source.addEventListener("hello", (ev) => {
      const version = (parse(ev) as { version?: string } | null)?.version;
      if (version && version !== BUILD_VERSION) {
        useBanners.getState().push({
          id: "version", tone: "bad", title: "Afflatus was updated",
          text: `This page is version ${BUILD_VERSION}; the server now runs ${version}. Reload to get the new one: what is unsaved here may be lost.`,
          href: "/", go: "Reload", act: () => location.reload(),
        });
      }
      if (greeted) void client.invalidateQueries();
      greeted = true;
    });
    return () => {
      readQueue.cancel();
      readLibrary.cancel();
      unwatch();
      source.close();
    };
  }, [client, notifier]);
}
