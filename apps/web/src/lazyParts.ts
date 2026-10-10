/**
 * The parts of the app that are chunks of their own: not needed to draw the Studio as it opens, so they are not in the
 * first load. The Studio's own (its form, a tile's menu, the viewer) are fetched once the page is idle, so that the first
 * time one is opened it draws at once; another screen's when a link to it is pointed at or focused (the moment between
 * that and the click is enough on a LAN), and the rest once the first screen has come, for a screen opened another way
 * (the command bar). Over a slow link the first screen's lists and pictures then have the line to themselves. Every lazy() of
 * one of them goes through its loader here (lazyPart): the early fetch and the opening are then the same request.
 */

import { createElement, lazy, useState, type ComponentType } from "react";

/** A chunk's loader: asked once (again after a failure), and what it gave kept, for a part to be drawn at once with it. */
export type Chunk<M> = (() => Promise<M>) & { loaded?: M };
function chunk<M>(load: () => Promise<M>): Chunk<M> {
  let asked: Promise<M> | undefined;
  const c: Chunk<M> = () =>
    (asked ??= load().then(
      (m) => (c.loaded = m),
      (err: unknown) => {
        asked = undefined;
        throw err;
      },
    ));
  return c;
}

export const loadCreatePanel = chunk(() => import("./screens/studio/CreatePanel"));
export const loadTimelineCards = chunk(() => import("./screens/studio/TimelineCards"));
export const loadProjectsPanel = chunk(() => import("./projects/ProjectsPanel"));
export const loadViewer = chunk(() => import("./Viewer"));
export const loadTileMenuBody = chunk(() => import("./TileMenuBody"));

export const loadPeople = chunk(() => import("./screens/People"));
export const loadQueue = chunk(() => import("./screens/Queue"));
export const loadSetup = chunk(() => import("./screens/Setup"));
export const loadTimelineEditor = chunk(() => import("./screens/TimelineEditor"));
export const loadWorkflows = chunk(() => import("./screens/Workflows"));

/**
 * A component of a chunk, as lazy() makes it, but drawn at once when its chunk has come already (fetched while the page
 * was idle): a lazy() always waits a turn the first time, and its Suspense fallback ("Loading…") flashed for a frame.
 * Still wrapped in a Suspense where it is used, for the chunk that has not come yet.
 */
export function lazyPart<M, P extends object>(load: Chunk<M>, pick: (m: M) => ComponentType<P>): ComponentType<P> {
  const Lazy = lazy(() => load().then((m) => ({ default: pick(m) })));
  return function Part(props: P) {
    // chosen once per mount: one that started on the lazy() keeps it when the chunk lands, rather than being drawn afresh
    const [Comp] = useState<ComponentType<P>>(() => (load.loaded ? pick(load.loaded) : Lazy));
    return createElement(Comp, props);
  };
}

/** Runs `f` once nothing else happens (or after a while, where the browser has no idle callback). */
export function whenIdle(f: () => void): void {
  const idle = window.requestIdleCallback ?? ((g: () => void) => window.setTimeout(g, 1500));
  idle(f, { timeout: 4000 } as IdleRequestOptions);
}

/** How long the page has fetched nothing new before the other screens' chunks are fetched: its first screen is in. */
const QUIET_MS = 1000;
/** And at the latest, when it never goes quiet that long (a scroll through the library, a render's preview frames). */
const LATER_MS = 10_000;

/**
 * Runs `f` once the page has fetched nothing for a while (the first screen's lists and thumbnails have all come), or
 * after LATER_MS. Watched with an observer, which sees every request that ends, past the timeline's buffer of 250 too.
 */
function whenQuiet(f: () => void): void {
  const start = performance.now();
  let last = start;
  const seen = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver(() => (last = performance.now()));
  try {
    seen?.observe({ type: "resource", buffered: true });
  } catch {
    // no resource timing here: the latest moment only
  }
  const check = () => {
    const at = performance.now();
    if (at - last < QUIET_MS && at - start < LATER_MS) return void window.setTimeout(check, QUIET_MS / 4);
    seen?.disconnect();
    f();
  };
  window.setTimeout(check, QUIET_MS);
}

/** The chunk a screen's address needs, by the address's start. */
const SCREENS: Array<[RegExp, () => Promise<unknown>]> = [
  [/^\/queue(\/|$)/, loadQueue],
  [/^\/settings(\/|$)/, loadSetup],
  [/^\/(kit|people)(\/|$)/, loadPeople],
  [/^\/workflows(\/|$)/, loadWorkflows],
  [/^\/timelines\/[^/?#]+/, loadTimelineEditor],
];

/** The chunk of the screen an address opens (a link's href), or null when it needs none (the Studio, another site). */
export function chunkFor(href: string): (() => Promise<unknown>) | null {
  return SCREENS.find(([at]) => at.test(href))?.[1] ?? null;
}

/** Starts fetching the chunk of the screen a link leads to, once: the link was pointed at, touched or focused. */
function onLink(e: Event): void {
  const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
  const load = link && chunkFor(link.getAttribute("href") ?? "");
  // a chunk that failed to come is asked again on its opening (chunk() forgets a failure)
  if (load) load().catch(() => {});
}

let started = false;

/**
 * Fetches the Studio's chunks while nothing else happens (a tile's menu, its form, its timelines, the Projects panel, the
 * viewer); another screen's as a link to it is pointed at or focused, anywhere on the page (the rail, a timeline's card,
 * a banner's link); and every other screen's once the first screen's requests are all in (whenQuiet), one idle moment
 * each: nothing they do competes with the first paint, nor with the first screen's lists and thumbnails over a slow link.
 */
export function prefetchWhenIdle(): void {
  if (started) return;
  started = true;
  for (const type of ["pointerover", "focusin"]) document.addEventListener(type, onLink, { passive: true, capture: true });
  const studio = [loadTileMenuBody, loadCreatePanel, loadTimelineCards, loadProjectsPanel, loadViewer];
  const later: Array<Array<() => Promise<unknown>>> = [
    [loadQueue, loadSetup, loadPeople],
    [loadWorkflows, loadTimelineEditor],
  ];
  const next = (i: number) => {
    const wave = later[i];
    if (wave) whenIdle(() => void Promise.allSettled(wave.map((load) => load())).then(() => next(i + 1)));
  };
  whenIdle(() => void Promise.allSettled(studio.map((load) => load())));
  whenQuiet(() => next(0));
}
