import { useEffect } from "react";
import { useLocation } from "wouter";
import { create } from "zustand";
import { api } from "./api";
import { useTimelineRequest } from "./bar/bridge";
import { useProject } from "./project";
import { settingHref, tabHref, type Tab } from "./screens/settings/settingsIndex";
import { useBanners, useHandover, useOpenDraft, useStudio } from "./store";
import { browserKey } from "./whereReport";

/**
 * An agent shows the user what it made (MCP's show_page, server mcpShow.ts): a "show" live event names a draft, a timeline
 * and maybe a clip, a library item or a Settings tab. The tab in front of the browser it is for goes there, unless the user
 * typed in the last few seconds: it then says "<token> wants to show you …" with Go, and leaves them be. It answers the
 * server which it did, for the agent. A tab in the background does nothing: the agent is told no page was in front.
 */

/** Where a page is asked to go (server mcpShow.ts ShowTo). */
export type ShowTo =
  | { draft: string }
  | { timeline: string; clip?: number }
  | { item: string; folder: string | null; project: string | null; inBin: boolean }
  | { settings: Tab; setting?: string };

/** What a "show" live event says (server mcpShow.ts ShowEvent). */
export interface ShowEvent {
  ask: string;
  by: string;
  browser: string | null;
  said: string;
  to: ShowTo;
}

/** Typing this recently, the page is not moved under the user's hands: it asks. */
export const TYPING_MS = 5000;

let typedAt = 0;
/** Whether the user typed in the last TYPING_MS: a key in a field, or a field's text changed. */
export const typingNow = (now = Date.now()) => now - typedAt < TYPING_MS;

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** The shows heard, one at a time: the newest, and a count that tells a show from the one before. */
export const useAgentShows = create<{ last: ShowEvent | null; seq: number; heard(e: ShowEvent): void }>((set) => ({
  last: null,
  seq: 0,
  heard: (e) => set((s) => ({ last: e, seq: s.seq + 1 })),
}));

/** Whether a show is this page's to act on: for this browser, and the tab in front. */
export const forThisPage = (e: ShowEvent) => (!e.browser || e.browser === browserKey()) && document.visibilityState === "visible";

/** Go where a show asks, as the command bar opens the same things. */
function goTo(to: ShowTo, navigate: (path: string) => void): void {
  if ("draft" in to) {
    useOpenDraft.getState().open(to.draft);
    useStudio.getState().set({ form: true, scope: "draft" });
    navigate("/");
  } else if ("timeline" in to) {
    navigate(`/timelines/${to.timeline}`);
    // the editor selects it once its timeline is read, as a click on it in the track; nothing is waited for
    if (to.clip) void useTimelineRequest.getState().ask({ timeline: to.timeline, do: "select", clip: to.clip });
  } else if ("item" in to) {
    // an item of another project is shown where it lives, as the Projects panel's "Show in the Studio"
    if (useProject.getState().id !== (to.project ?? "none")) useProject.getState().set(to.project ?? "none");
    useStudio.getState().set({ place: to.inBin ? { type: "bin" } : to.folder ? { type: "folder", id: to.folder } : { type: "unfiled" } });
    useHandover.getState().set({ show: to.item });
    navigate("/");
  } else {
    navigate(to.setting ? settingHref(to.setting, to.settings) : tabHref(to.settings));
  }
}

/** Takes the shows an agent asks for (App.tsx): goes there, or asks while the user types. */
export function useAgentShow(): void {
  const [, navigate] = useLocation();
  const seq = useAgentShows((s) => s.seq);
  useEffect(() => {
    const typed = (e: Event) => {
      if (e.type === "input" || editable(e.target)) typedAt = Date.now();
    };
    window.addEventListener("keydown", typed, true);
    window.addEventListener("input", typed, true);
    return () => {
      window.removeEventListener("keydown", typed, true);
      window.removeEventListener("input", typed, true);
    };
  }, []);
  useEffect(() => {
    const e = useAgentShows.getState().last;
    if (!seq || !e || !forThisPage(e)) return;
    if (typingNow()) {
      useBanners.getState().push({
        id: `agent-show:${e.ask}`, tone: "good", title: `${e.by} wants to show you ${e.said}`,
        action: { label: "Go", run: () => goTo(e.to, navigate) },
      });
      void api.whereShown(e.ask, "asked").catch(() => {});
      return;
    }
    goTo(e.to, navigate);
    void api.whereShown(e.ask, "moved").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each show heard once
  }, [seq]);
}
