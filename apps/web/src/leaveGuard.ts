import { useEffect, useRef } from "react";
import type { RouterProps } from "wouter";

/**
 * Work that lives only on its screen (a workflow being mapped) asks before it is left: every way to another
 * screen goes through the router's navigate (the rail, the command bar, a link, a redirect), and this stands
 * in front of it. Closing or reloading the tab is asked by the browser.
 */

type Guard = () => Promise<boolean>;
let guard: Guard | null = null;

/** The router's wrap round every navigation: with work that would be lost, the question first; no, and it stays. */
export const aroundNav: NonNullable<RouterProps["aroundNav"]> = (navigate, to, options) => {
  const g = guard;
  // the same screen (its rail entry clicked again) keeps what is on it: nothing to ask
  if (!g || to.split(/[?#]/)[0] === window.location.pathname) return navigate(to, options);
  void g().then((leave) => leave && navigate(to, options));
};

/** While `dirty`, leaving the screen asks `question` first (true: leave), and the browser asks before the tab closes. */
export function useLeaveGuard(dirty: boolean, question: Guard) {
  const ref = useRef(question);
  ref.current = question;
  useEffect(() => {
    if (!dirty) return;
    const mine: Guard = () => ref.current();
    guard = mine;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => {
      if (guard === mine) guard = null;
      window.removeEventListener("beforeunload", ask);
    };
  }, [dirty]);
}
