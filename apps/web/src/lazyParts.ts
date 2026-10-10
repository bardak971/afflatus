/**
 * The parts of the app that are chunks of their own: not needed to draw the Studio as it opens, so they are not in the
 * first load, and fetched once the page is idle, so that the first time one is opened it draws at once. Every lazy()
 * of one of them goes through its loader here (lazyPart): the idle fetch and the opening are then the same request.
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

let started = false;

/**
 * Fetches the chunks while nothing else happens, the Studio's own first (a tile's menu, its form, its timelines, the
 * Projects panel, the viewer), then the other screens, one idle moment each: nothing they do competes with the first
 * paint.
 */
export function prefetchWhenIdle(): void {
  if (started) return;
  started = true;
  const waves: Array<Array<() => Promise<unknown>>> = [
    [loadTileMenuBody, loadCreatePanel, loadTimelineCards, loadProjectsPanel, loadViewer],
    [loadQueue, loadSetup, loadPeople],
    [loadWorkflows, loadTimelineEditor],
  ];
  const next = (i: number) => {
    const wave = waves[i];
    if (wave) whenIdle(() => void Promise.allSettled(wave.map((load) => load())).then(() => next(i + 1)));
  };
  next(0);
}
