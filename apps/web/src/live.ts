import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ProgressUpdate, QueueStatus, SystemLoad } from "./api";
import { readHistoryHead } from "./data";
import { applyChange } from "./assetCache";
import { endedSince, mergeProgress, notifyTag, throttle } from "./liveState";
import { useBanners, useLive, useNotify, useSystem } from "./store";
import { useBar } from "./bar/store";
import { isUnder, libraryInPlace, libraryReads, queryKeys, RENDER_KEYS, type LibraryChange } from "./queryKeys";

/** The version this page was built as (vite.config.ts), "dev" from the sources: what the server's hello is held against. */
const BUILD_VERSION = __AFFLATUS_VERSION__;

const parse = (data: string): unknown => {
  try {
    return JSON.parse(data);
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

/** Every event the server sends (events.ts): what the tab with the connection listens for and passes on. */
const EVENTS = ["hello", "ping", "system", "progress", "queue", "library", "models", "timeline", "entities", "downloads", "setup"] as const;
/** The events after which the command bar's index is old. */
const INDEXED = new Set(["library", "timeline", "queue", "entities", "models"]);
/** The lock of the tab that holds the connection, and the channel it passes the events on over. */
const LOCK = "afflatus.live";
const CHANNEL = "afflatus.live";
/** A connection down this long is said in the status bar: a server restarting is often back sooner. */
const DOWN_AFTER_MS = 4000;
/** Heard nothing this long (the server beats every 10 s): the stream is dead though it looks open, as a proxy can leave it after the server went. */
const SILENT_MS = 30_000;
/** The waits before each try to open a closed connection again; the last one repeats. */
const RETRY_MS = [1000, 2000, 5000, 10_000];

/** What goes over the channel: an event as it came, whether the connection is down, a new tab asking which. */
type Relayed = { event: string; data: string } | { down: boolean } | { ask: true };

/**
 * One event stream for the whole app. The server says what changed; the matching queries refetch.
 * Nothing polls: an idle app makes no requests.
 *
 * And one stream for the whole browser: over HTTP/1.1 a browser keeps six connections to a host, and a
 * stream held open by every tab would leave none for the reads once six tabs are open. The first tab
 * holds a lock and the connection, and passes every event on to the others over a BroadcastChannel; they
 * do with it exactly what it does. When it closes, the next tab takes the lock and opens the connection.
 * Without locks or the channel, every tab has its own, as before.
 */
export function useLiveEvents(): void {
  const client = useQueryClient();
  const notifier = useNotifier();
  useEffect(() => {
    const on = (key: readonly string[]) => () => refetch(client, [key]);

    // the queue, and the library, are read again at most once a second, with one last read after the last
    // event: a render reporting every step, or a folder of a thousand files coming in, costs a read a second
    const readQueue = throttle(() => void client.invalidateQueries({ queryKey: queryKeys.queue(), exact: true }), 1000);
    // each "library" event says what it changed: what it says in full (a new name, a keep) is written in at once, and the
    // changes are gathered until the read, which reads only the queries one of them can touch (queryKeys.ts libraryReads)
    let libraryWaiting: Array<LibraryChange | null> = [];
    const libraryRead = throttle(() => {
      const reads = libraryReads(libraryWaiting);
      libraryWaiting = [];
      void client.invalidateQueries({ predicate: (q) => reads(q.queryKey), refetchType: "active" });
    }, 1000);
    const readLibrary = (data: string) => {
      const change = parse(data) as LibraryChange | null;
      const inPlace = libraryInPlace(change);
      if (inPlace) applyChange(client, inPlace);
      libraryWaiting.push(change);
      libraryRead();
    };

    // a job that ended, seen in the queue as it is read: the history and the render times are read again,
    // and what was asked to be told is told (a render that finished, the queue running empty)
    let seen: Set<string> | null = null;
    let busy = false;
    const unwatch = client.getQueryCache().subscribe((e) => {
      // a read of the queue, not a change made in place (a progress event, a new order)
      if (e.type !== "updated" || e.action.type !== "success" || e.action.manual || e.query.queryKey.length !== 1 || !isUnder(e.query.queryKey, queryKeys.queue())) return;
      const q = e.query.state.data as QueueStatus | undefined;
      if (!q) return;
      const first = seen === null;
      const now = endedSince(seen, q);
      seen = now.seen;
      const working = Boolean(q.running) || q.waiting.length > 0;
      // and the timelines when a clip's render, a cut or an export ended: its new take arrives with its job's end, even
      // when the "timeline" event that says so was missed (a dropped connection) or read before the take was in
      const onTimeline = now.ended.some((j) => j.clipId || j.kind === "cut" || j.kind === "export");
      // the history: its first page only, with the jobs that ended put in front of what is loaded (data.ts)
      if (now.ended.length) {
        void readHistoryHead(client);
        refetch(client, [...RENDER_KEYS, ...(onTimeline ? [queryKeys.timelines.all()] : [])]);
      }
      if (!first && notifier.current) {
        const { whenEmpty, eachRender } = useNotify.getState();
        for (const j of now.ended) if (eachRender && j.status !== "cancelled" && j.kind !== "load") say(j.status === "done" ? "Finished" : "Failed", j.label, notifyTag(j.id));
        if (whenEmpty && busy && !working) say("The queue is empty", "Everything that was waiting is done.", "afflatus:empty");
      }
      busy = working;
    });

    // the command bar's index: marked old a moment after the last of a run of changes, read again at once only while the bar is open
    let indexWait: ReturnType<typeof setTimeout> | null = null;
    const readIndex = () => {
      if (indexWait) clearTimeout(indexWait);
      indexWait = setTimeout(() => void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all(), refetchType: useBar.getState().open ? "active" : "none" }), 300);
    };

    // the first hello is the page opening: everything was just read. A later one is a reconnect (or another tab
    // taking the connection over), after which anything may have changed; and a server of another version means
    // this page is out of date
    let greeted = false;
    const handlers: Record<string, (data: string) => void> = {
      queue: readQueue,
      library: readLibrary,
      progress: (data) => {
        // with the job's figures in the event, the running job is changed in place: nothing is fetched
        const merged = mergeProgress(client.getQueryData<QueueStatus>(queryKeys.queue()), parse(data) as Partial<ProgressUpdate> | null);
        if (merged) client.setQueryData<QueueStatus>(queryKeys.queue(), merged);
        else readQueue();
      },
      models: on(queryKeys.modelInfo.all()),
      // a timeline changed: its card, and the Projects panel's tree when it is open (its clips, its size)
      timeline: () => refetch(client, [queryKeys.timelines.all(), queryKeys.projects.trees()]),
      entities: on(queryKeys.entities()),
      downloads: on(queryKeys.downloads()),
      // ComfyUI has a file it did not have: what is ready may have changed
      setup: on(queryKeys.setup()),
      system: (data) => {
        const got = parse(data) as { load: SystemLoad | null } | null;
        if (got) useSystem.getState().set(got.load);
      },
      hello: (data) => {
        const version = (parse(data) as { version?: string } | null)?.version;
        if (version && version !== BUILD_VERSION) {
          useBanners.getState().push({
            id: "version", tone: "bad", title: "Afflatus was updated",
            text: `This page is version ${BUILD_VERSION}; the server now runs ${version}. Reload to get the new one: what is unsaved here may be lost.`,
            href: "/", go: "Reload", act: () => location.reload(),
          });
        }
        // everything read again, but the command bar's index, which is only marked old: the bar reads it when it opens
        // next (its search of the library's items is under the same key)
        if (greeted) {
          void client.invalidateQueries({ predicate: (q) => !isUnder(q.queryKey, queryKeys.commandIndex.all()) });
          void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all(), refetchType: useBar.getState().open ? "active" : "none" });
        }
        greeted = true;
      },
    };
    // the one place an event is acted on: from this tab's own connection or passed on by the tab that has it
    const handle = (name: string, data: string) => {
      handlers[name]?.(data);
      if (INDEXED.has(name)) readIndex();
    };

    const shared = typeof navigator !== "undefined" && Boolean(navigator.locks) && typeof BroadcastChannel !== "undefined";
    const channel = shared ? new BroadcastChannel(CHANNEL) : null;
    const tell = (m: Relayed) => channel?.postMessage(m);

    // the connection, in the tab that holds it. Down a moment (the browser tries again by itself) says nothing;
    // down a few seconds is said, here and in the other tabs. Closed for good (an answer that is not the stream,
    // a proxy's 502 while the server restarts), it is opened again after a wait that grows
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let downWait: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    let down = false;
    let heard = Date.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const markDown = (now: boolean) => {
      if (now === down) return;
      down = now;
      useLive.getState().set(now);
      tell({ down: now });
    };
    /** The stream given up: said down after a moment, opened again after a wait that grows. */
    const drop = (s: EventSource) => {
      s.close();
      if (source === s) source = null;
      downWait ??= setTimeout(() => markDown(true), DOWN_AFTER_MS);
      retry ??= setTimeout(open, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
    };
    const open = () => {
      retry = null;
      const s = new EventSource("/api/events");
      source = s;
      heard = Date.now();
      watchdog ??= setInterval(() => {
        if (source && Date.now() - heard > SILENT_MS) drop(source);
      }, 5000);
      for (const name of EVENTS) {
        s.addEventListener(name, (ev) => {
          heard = Date.now();
          const data = (ev as MessageEvent<string>).data;
          handle(name, data);
          tell({ event: name, data });
        });
      }
      s.addEventListener("open", () => {
        tries = 0;
        if (downWait) clearTimeout(downWait);
        downWait = null;
        markDown(false);
      });
      s.addEventListener("error", () => {
        downWait ??= setTimeout(() => markDown(true), DOWN_AFTER_MS);
        if (s.readyState === EventSource.CLOSED) drop(s);
      });
    };

    const stop = new AbortController();
    if (!channel) open();
    else {
      channel.onmessage = (e: MessageEvent<Relayed>) => {
        const m = e.data;
        // the tab with the connection: a new tab asks whether it is down
        if (source || retry) {
          if ("ask" in m) tell({ down });
          return;
        }
        if ("event" in m) handle(m.event, m.data);
        else if ("down" in m) useLive.getState().set(m.down);
      };
      // held until the tab goes; what the tab before said about the connection is where this one starts from
      const hold = () => {
        if (stop.signal.aborted) return;
        down = useLive.getState().down;
        open();
        return new Promise<void>((done) => stop.signal.addEventListener("abort", () => done()));
      };
      navigator.locks
        .request(LOCK, { ifAvailable: true }, async (lock) => {
          if (lock) return hold();
          // another tab has the connection: this one follows it (what it read on opening is current, so the next
          // hello is a reconnect), and waits its turn
          greeted = true;
          tell({ ask: true });
          await navigator.locks.request(LOCK, { signal: stop.signal }, hold);
        })
        .catch(() => {});
    }
    return () => {
      stop.abort();
      readQueue.cancel();
      libraryRead.cancel();
      if (indexWait) clearTimeout(indexWait);
      if (retry) clearTimeout(retry);
      if (downWait) clearTimeout(downWait);
      if (watchdog) clearInterval(watchdog);
      unwatch();
      source?.close();
      channel?.close();
    };
  }, [client, notifier]);
}
