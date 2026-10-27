import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoticeEvent, ProgressUpdate, QueueStatus, UpdateFlow, UpdatesView } from "./api";
import { readHistoryHead, readLibraryTop } from "./data";
import { applyChange, readsTop } from "./assetCache";
import { madeHere } from "./assetChange";
import { endedSince, greetings, mergeProgress, notifyTag, systemAfter, throttle } from "./liveState";
import { useAgentEdits, useKitEdits, useTimelineEdits, type DraftEdit, type KitEdit, type TimelineEdit } from "./agentEdits";
import { useBanners, useLive, useNotify, useSystem } from "./store";
import { useBar } from "./bar/store";
import { isUnder, libraryInPlace, libraryReads, queryKeys, RENDER_KEYS, type LibraryChange } from "./queryKeys";
import { backFromRestart, followRestart, readsAgain, useRestarting } from "./updates";
import { timelineReader } from "./timelineReads";

/** What else hears the library's changes as they come (hearLibrary): a viewer waiting for what its cut makes. */
const libraryHeard = new Set<(change: LibraryChange) => void>();
/** Hears every "library" event until the function it gives back is called. */
export function hearLibrary(heard: (change: LibraryChange) => void): () => void {
  libraryHeard.add(heard);
  return () => void libraryHeard.delete(heard);
}

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
const EVENTS = ["hello", "ping", "system", "progress", "queue", "library", "models", "timeline", "entities", "downloads", "setup", "updates", "notice", "draft", "kit", "timelineEdit"] as const;
/** The events after which the command bar's index is old. */
const INDEXED = new Set(["library", "timeline", "queue", "entities", "models"]);
/** The lock of the tab that holds the connection, and the channel it passes the events on over. */
const LOCK = "afflatus.live";
const CHANNEL = "afflatus.live";
/** A connection down this long is said in the status bar: a server restarting is often back sooner. */
const DOWN_AFTER_MS = 4000;
/** How often the running jobs' figures from the progress events are written into the queue on screen, at most. */
const PROGRESS_EVERY_MS = 100;
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
    // the GPU hunt's own view goes with it (its asks, its ranking): read again only where it is on screen (the hunt's card)
    // the Deploy dialog's "Your waiting jobs" follows the queue too while it is open, at most every 5 s (each read scans
    // ComfyUI's files and asks where each file would come from)
    const readDeployModels = throttle(() => void client.invalidateQueries({ queryKey: ["deploy-models"], refetchType: "active" }), 5000);
    const readQueue = throttle(() => {
      void client.invalidateQueries({ queryKey: queryKeys.queue(), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.hunt(), refetchType: "active" });
      readDeployModels();
    }, 1000);
    // each "library" event says what it changed: what it says in full (a new name, a keep) is written in at once, and the
    // changes are gathered until the read, which reads only the queries one of them can touch (queryKeys.ts libraryReads)
    let libraryWaiting: Array<LibraryChange | null> = [];
    const libraryRead = throttle(() => {
      const reads = libraryReads(libraryWaiting);
      // only items added (a render that finished, an upload): a list newest first on screen reads its first page alone
      const added = libraryWaiting.every((c) => c?.change === "added");
      libraryWaiting = [];
      const tops = added ? client.getQueryCache().findAll({ predicate: (q) => q.isActive() && reads(q.queryKey) && readsTop(q.queryKey, q.state.data) }) : [];
      const byTop = new Set(tops.map((q) => q.queryHash));
      void client.invalidateQueries({ predicate: (q) => reads(q.queryKey) && !byTop.has(q.queryHash), refetchType: "active" });
      for (const q of tops) void readLibraryTop(client, q.queryKey);
    }, 1000);
    const readLibrary = (data: string) => {
      const change = parse(data) as LibraryChange | null;
      // a change made in this tab: written on screen already, and what it touches read once it was done (assetChange.tsx)
      if (!madeHere(change)) {
        const inPlace = libraryInPlace(change);
        if (inPlace) applyChange(client, inPlace);
        libraryWaiting.push(change);
        libraryRead();
      }
      if (change) for (const heard of libraryHeard) heard(change);
    };

    // the timelines, after a "timeline" event or a clip's job that ended: gathered, and not read again where a read sent
    // since stands for the change (an edit's own read back; timelineReads.ts)
    const readTimelines = timelineReader(client);

    // a job that ended, seen in the queue as it is read: the history and the render times are read again (what is told of
    // it comes from the server, as a "notice")
    let seen: Set<string> | null = null;
    const unwatch = client.getQueryCache().subscribe((e) => {
      // a read of the queue, not a change made in place (a progress event, a new order)
      if (e.type !== "updated" || e.action.type !== "success" || e.action.manual || e.query.queryKey.length !== 1 || !isUnder(e.query.queryKey, queryKeys.queue())) return;
      const q = e.query.state.data as QueueStatus | undefined;
      if (!q) return;
      const now = endedSince(seen, q);
      seen = now.seen;
      // and the timelines when a clip's render, a cut or an export ended: its new take arrives with its job's end, even
      // when the "timeline" event that says so was missed (a dropped connection) or read before the take was in
      const onTimeline = now.ended.some((j) => j.clipId || j.kind === "cut" || j.kind === "export");
      // the history: its first page only, with the jobs that ended put in front of what is loaded (data.ts)
      if (now.ended.length) {
        void readHistoryHead(client);
        refetch(client, RENDER_KEYS);
        if (onTimeline) readTimelines();
      }
    });

    // the command bar's index: marked old a moment after the last of a run of changes, read again at once only while the bar is open
    let indexWait: ReturnType<typeof setTimeout> | null = null;
    const readIndex = () => {
      if (indexWait) clearTimeout(indexWait);
      indexWait = setTimeout(() => void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all(), refetchType: useBar.getState().open ? "active" : "none" }), 300);
    };

    // the first hello is the page opening: everything was just read. A later one is a reconnect (or this tab taking
    // the connection over from another), after which anything may have changed (liveState.ts greetings); and a server
    // of another version means this page is out of date
    const greeted = greetings();
    // the progress events waiting to be written in, by job (the last figures of each)
    const progressWaiting = new Map<string, Partial<ProgressUpdate>>();
    let progressFlush: number | null = null;
    const writeProgress = () => {
      progressFlush = null;
      const all = [...progressWaiting.values()];
      progressWaiting.clear();
      const merged = mergeProgress(client.getQueryData<QueueStatus>(queryKeys.queue()), { all });
      if (merged) client.setQueryData<QueueStatus>(queryKeys.queue(), merged);
      else readQueue();
    };
    const handlers: Record<string, (data: string) => void> = {
      queue: readQueue,
      library: readLibrary,
      progress: (data) => {
        // with the job's figures in the event, the running job is changed in place: nothing is fetched. The events of a
        // tenth of a second are written in together: each write draws again every screen part that reads the queue, and
        // with several machines rendering pictures that came to ~36 a second (the bars glide between them, progress/style.ts)
        const said = parse(data) as (Partial<ProgressUpdate> & { all?: Array<Partial<ProgressUpdate>> }) | null;
        if (!said) return readQueue();
        for (const u of said.all ?? [said]) if (typeof u.id === "string") progressWaiting.set(u.id, { ...progressWaiting.get(u.id), ...u });
        progressFlush ??= window.setTimeout(writeProgress, PROGRESS_EVERY_MS);
      },
      models: on(queryKeys.modelInfo.all()),
      // a timeline changed: its card, and the Projects panel's tree when it is open (its clips, its size)
      timeline: () => readTimelines({ tree: true }),
      entities: on(queryKeys.entities()),
      // a draft an MCP token changed: the open form follows it, its fields ringed, with Undo (agentEdits.ts, draft.ts)
      draft: (data) => {
        const e = parse(data) as DraftEdit | null;
        if (typeof e?.id === "string" && Array.isArray(e.fields)) useAgentEdits.getState().heard(e);
      },
      // an item of the Prompt kit an MCP token changed: the kit open on it follows, ringed, with Undo (agentEdits.ts, useEntityDraft)
      kit: (data) => {
        const e = parse(data) as KitEdit | null;
        if (typeof e?.id === "string" && Array.isArray(e.fields)) useKitEdits.getState().heard(e);
      },
      // a timeline an MCP token changed: the editor open on it says so with Undo, the clips ringed (agentEdits.ts, useAgentTimeline);
      // the timeline itself is read again on the "timeline" event that comes with it
      timelineEdit: (data) => {
        const e = parse(data) as TimelineEdit | null;
        if (typeof e?.id === "string" && Array.isArray(e.clips)) useTimelineEdits.getState().heard(e);
      },
      // what the server tells of (notify.ts): a notification of this browser where its kind is ticked here, shown by one tab
      notice: (data) => {
        const n = parse(data) as NoticeEvent | null;
        if (n?.kind && notifier.current && useNotify.getState().browser[n.kind]) say(n.title, n.body, notifyTag(`${n.kind}:${n.title}`));
      },
      downloads: on(queryKeys.downloads()),
      // ComfyUI has a file it did not have: what is ready may have changed; or the machines changed (one added, a rented pod
      // that came up or went, a lock): the settings that list them too
      setup: () => refetch(client, [queryKeys.setup(), queryKeys.settings()]),
      // an update's flow: its progress written in place, the whole view read again when its phase changes (updates.ts)
      updates: (data) => {
        const flow = (parse(data) as { flow?: UpdateFlow | null } | null)?.flow ?? null;
        const view = client.getQueryData<UpdatesView>(queryKeys.updates());
        followRestart(view?.version ?? BUILD_VERSION, flow);
        if (view) client.setQueryData<UpdatesView>(queryKeys.updates(), { ...view, flow });
        if (!view || readsAgain(view.flow, flow)) void client.invalidateQueries({ queryKey: queryKeys.updates() });
      },
      // the machines' load: whole as the stream opens, then only the machines whose load changed (liveState.ts systemAfter)
      system: (data) => {
        const now = systemAfter(useSystem.getState(), parse(data) as Parameters<typeof systemAfter>[1]);
        if (now) useSystem.getState().set(now.load, now.loads);
      },
      hello: (data) => {
        const version = (parse(data) as { version?: string } | null)?.version;
        const again = greeted.hello();
        // the server is back from the restart this page waited for (an update, Go back, the move): the page is read again,
        // which brings the new version's own page, rather than the banner below
        if (backFromRestart(useRestarting.getState().from, version, again)) {
          location.reload();
          return;
        }
        if (version && version !== BUILD_VERSION) {
          useBanners.getState().push({
            id: "version", tone: "bad", title: "Afflatus was updated",
            text: `This page is version ${BUILD_VERSION}; the server now runs ${version}. Reload to get the new one: what is unsaved here may be lost.`,
            href: "/", go: "Reload", act: () => location.reload(),
          });
        }
        // everything read again, but the command bar's index, which is only marked old: the bar reads it when it opens
        // next (its search of the library's items is under the same key)
        if (again) {
          void client.invalidateQueries({ predicate: (q) => !isUnder(q.queryKey, queryKeys.commandIndex.all()) });
          void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all(), refetchType: useBar.getState().open ? "active" : "none" });
        }
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
        // the tab with the connection: a new tab asks whether it is down, and is told the machines' load whole (the stream
        // sends only what changed)
        if (source || retry) {
          if ("ask" in m) {
            tell({ down });
            const { load, loads } = useSystem.getState();
            tell({ event: "system", data: JSON.stringify({ load, loads }) });
          }
          return;
        }
        // another tab has the connection and speaks: what this one read on opening follows its events from here
        if (!("ask" in m)) greeted.followed();
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
          // another tab may have the connection: this one asks, follows it once it answers (see greetings), and waits its
          // turn. One that is going away (the page this one was opened from) does not answer
          tell({ ask: true });
          await navigator.locks.request(LOCK, { signal: stop.signal }, hold);
        })
        .catch(() => {});
    }
    return () => {
      stop.abort();
      readQueue.cancel();
      readDeployModels.cancel();
      libraryRead.cancel();
      readTimelines.cancel();
      if (indexWait) clearTimeout(indexWait);
      if (retry) clearTimeout(retry);
      if (downWait) clearTimeout(downWait);
      if (watchdog) clearInterval(watchdog);
      if (progressFlush !== null) clearTimeout(progressFlush);
      unwatch();
      source?.close();
      channel?.close();
    };
  }, [client, notifier]);
}
