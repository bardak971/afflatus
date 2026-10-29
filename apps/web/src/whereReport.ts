import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { api } from "./api";
import { useSelectedClip } from "./bar/bridge";
import { useOpenDraft } from "./store";

/**
 * Where this page is, said to the server for an agent's `whats_open` (server whatsOpen.ts): the address, and the draft,
 * timeline or clip open there. Cheap: said a moment after it changes, and again each time the page comes to the front (the
 * device used last is the one an agent works with: with a wait of 30 s there, a phone used meanwhile stayed the one said).
 */

/** A key of this browser's own, kept: what tells its reports from another browser's when there is no session. */
export function browserKey(): string {
  try {
    let key = localStorage.getItem("afflatus.where-key");
    if (!key) {
      // getRandomValues, not randomUUID: the page may be open over plain http on the network, where randomUUID is not given
      key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("afflatus.where-key", key);
    }
    return key;
  } catch {
    return "no-storage-key";
  }
}

const SETTLE_MS = 800;
/** The focus and the page shown come together as the page comes to the front: said once. */
const FRONT_MS = 2_000;

/** What a page says of itself, from its address, its open draft and its selected clip. */
export function whereOf(path: string, draft: string | null, clip: { timeline: string; id: string } | null): { path: string; draft: string | null; timeline: string | null; clip: string | null } {
  const timeline = /^\/timelines\/([^/?#]+)/.exec(path)?.[1] ?? null;
  return {
    path,
    // the Studio's form is the draft's place: elsewhere, a draft left open is not where the user is
    draft: path === "/" || path === "/create" ? draft : null,
    timeline,
    clip: timeline && clip?.timeline === timeline ? clip.id : null,
  };
}

export function useWhereReport(): void {
  const [path] = useLocation();
  const draft = useOpenDraft((s) => s.id);
  const clip = useSelectedClip((s) => s.clip);
  const said = JSON.stringify(whereOf(path, draft, clip && { timeline: clip.timeline, id: clip.id }));
  const last = useRef<{ said: string; at: number }>({ said: "", at: 0 });
  const now = useRef(said);
  now.current = said;
  useEffect(() => {
    const send = (force: boolean) => {
      const at = Date.now();
      if (now.current === last.current.said && (!force || at - last.current.at < FRONT_MS)) return;
      last.current = { said: now.current, at };
      // nothing to say when it does not go: an agent then reads where the page was before
      api.where({ key: browserKey(), ...(JSON.parse(now.current) as ReturnType<typeof whereOf>) }).catch(() => {});
    };
    const settle = setTimeout(() => send(false), SETTLE_MS);
    const front = () => document.visibilityState === "visible" && send(true);
    window.addEventListener("focus", front);
    document.addEventListener("visibilitychange", front);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("focus", front);
      document.removeEventListener("visibilitychange", front);
    };
  }, [said]);
}
