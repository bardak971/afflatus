import { useEffect, useRef } from "react";
import type { BaseLocationHook, RouterProps } from "wouter";
import { useBrowserLocation } from "wouter/use-browser-location";

/**
 * Work that lives only on its screen (a workflow being mapped) asks before it is left. The app's own ways to
 * another screen go through the router's navigate (the rail, the command bar, a link, a redirect), and this
 * stands in front of it. The browser's Back and Forward move the address before anyone is asked, so while
 * the guard is up the router reads the screen's own address (`useGuardedLocation`), the guard puts it back in
 * the bar and asks then. Closing or reloading the tab is asked by the browser.
 */

type Guard = () => Promise<boolean>;
let guard: Guard | null = null;
// the guarded screen's address while the guard is up: its path is what the router draws
let held: { path: string; full: string } | null = null;

const disarm = () => {
  guard = null;
  held = null;
};

/** The router's wrap round every navigation: with work that would be lost, the question first; no, and it stays. */
export const aroundNav: NonNullable<RouterProps["aroundNav"]> = (navigate, to, options) => {
  const g = guard;
  // the same screen (its rail entry clicked again) keeps what is on it: nothing to ask
  if (!g || to.split(/[?#]/)[0] === window.location.pathname) return navigate(to, options);
  void g().then((leave) => {
    if (!leave) return;
    if (guard === g) disarm();
    navigate(to, options);
  });
};

/**
 * The router's location: the browser's, except while the guard is up, when it is the guarded screen's.
 * A render between Back moving the address and its popstate (any live update draws) would otherwise
 * read the new address and take the screen, and its work, away before the question.
 */
export const useGuardedLocation: BaseLocationHook = (opts?: { ssrPath?: string }) => {
  const [path, navigate] = useBrowserLocation(opts);
  return [held?.path ?? path, navigate];
};

/**
 * The screen's own way out, its question already answered (Cancel, then Discard): the guard comes down at once, so
 * the move to another address that follows is not asked again.
 */
export function releaseLeaveGuard() {
  disarm();
}

/** While `dirty`, leaving the screen asks `question` first (true: leave), and the browser asks before the tab closes. */
export function useLeaveGuard(dirty: boolean, question: Guard) {
  const ref = useRef(question);
  ref.current = question;
  useEffect(() => {
    if (!dirty) return;
    const mine: Guard = () => ref.current();
    const address = () => ({ path: window.location.pathname, full: window.location.pathname + window.location.search + window.location.hash });
    guard = mine;
    held = address();
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // the router's own moves (pushState / replaceState, announced by wouter): where this screen now is
    const moved = () => {
      if (guard === mine) held = address();
    };
    // Back / Forward: the address in the bar goes back to this screen's at once, then the question; kept,
    // nothing more to do; discarded, the address the browser went to replaces it and the router follows
    let asking = false;
    const popped = () => {
      if (guard !== mine || !held) return;
      const to = address().full;
      if (to === held.full) return;
      history.pushState(history.state, "", held.full);
      if (asking) return;
      asking = true;
      void mine().then((leave) => {
        asking = false;
        if (!leave || guard !== mine) return;
        disarm();
        history.replaceState(null, "", to);
      });
    };
    window.addEventListener("beforeunload", ask);
    window.addEventListener("popstate", popped);
    window.addEventListener("pushState", moved);
    window.addEventListener("replaceState", moved);
    return () => {
      if (guard === mine) disarm();
      window.removeEventListener("beforeunload", ask);
      window.removeEventListener("popstate", popped);
      window.removeEventListener("pushState", moved);
      window.removeEventListener("replaceState", moved);
    };
  }, [dirty]);
}
