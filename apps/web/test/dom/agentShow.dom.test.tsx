import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "wouter";
import { useAgentShow, useAgentShows, type ShowEvent } from "../../src/agentShow";
import { useTimelineRequest } from "../../src/bar/bridge";
import { useBanners, useHandover, useOpenDraft, useStudio } from "../../src/store";
import { browserKey } from "../../src/whereReport";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * An agent shows the user what it made (the server's mcpShow.ts, a "show" live event): the page goes there at once, unless
 * the user typed in the last few seconds, when a toast "<token> wants to show you …" offers Go and the page stays; either
 * way the server is told which. A show for another browser is left alone.
 */

function Page() {
  useAgentShow();
  const [path] = useLocation();
  return (
    <div>
      <span data-testid="at">{path}</span>
      <input aria-label="zz-test field" />
    </div>
  );
}

const show = (to: ShowEvent["to"], over: Partial<ShowEvent> = {}): ShowEvent => ({ ask: `zz-ask-${Math.random().toString(36).slice(2, 10)}`, by: "Claude Code", browser: browserKey(), said: "the draft “zz-test portrait”", to, ...over });
const newest = () => useBanners.getState().items.at(-1);
const at = () => screen.getByTestId("at").textContent;

let answers: Array<{ ask: string; did: string }>;
beforeEach(() => {
  useAgentShows.setState({ seq: 0, last: null });
  useBanners.setState({ items: [] });
  useOpenDraft.getState().open(null);
  answers = [];
  fakeApi.on("POST /where/shown", ({ body }) => (answers.push(body as { ask: string; did: string }), { ok: true }));
});

describe("an agent's show", () => {
  it("opens a draft in the Studio and says it went there", async () => {
    draw(<Page />, { at: "/queue" });
    const e = show({ draft: "zz-draft" });
    act(() => useAgentShows.getState().heard(e));
    await waitFor(() => expect(at()).toBe("/"));
    expect(useOpenDraft.getState().id).toBe("zz-draft");
    expect(useStudio.getState().form).toBe(true);
    await waitFor(() => expect(answers).toEqual([{ ask: e.ask, did: "moved" }]));
    expect(newest()).toBeUndefined();
  });

  it("opens a timeline with a clip selected, an item in its folder, a Settings row", async () => {
    draw(<Page />, { at: "/" });
    act(() => useAgentShows.getState().heard(show({ timeline: "zz-tl", clip: 3 })));
    await waitFor(() => expect(at()).toBe("/timelines/zz-tl"));
    expect(useTimelineRequest.getState().request).toEqual({ timeline: "zz-tl", do: "select", clip: 3 });
    act(() => useAgentShows.getState().heard(show({ item: "zz-item", folder: "zz-folder", project: null, inBin: false })));
    await waitFor(() => expect(at()).toBe("/"));
    expect(useStudio.getState().place).toEqual({ type: "folder", id: "zz-folder" });
    expect(useHandover.getState().show).toBe("zz-item");
    act(() => useAgentShows.getState().heard(show({ settings: "rented", setting: "rented.bootlogs" })));
    await waitFor(() => expect(at()).toBe("/settings/rented"));
  });

  it("asks while the user types: a toast with Go, the page stays until Go", async () => {
    draw(<Page />, { at: "/queue" });
    fireEvent.keyDown(screen.getByLabelText("zz-test field"), { key: "a" });
    const e = show({ draft: "zz-draft" });
    act(() => useAgentShows.getState().heard(e));
    await waitFor(() => expect(answers).toEqual([{ ask: e.ask, did: "asked" }]));
    expect(at()).toBe("/queue");
    expect(newest()).toMatchObject({ title: "Claude Code wants to show you the draft “zz-test portrait”", action: { label: "Go" } });
    act(() => newest()!.action!.run());
    await waitFor(() => expect(at()).toBe("/"));
    expect(useOpenDraft.getState().id).toBe("zz-draft");
  });

  it("leaves a show for another browser alone", async () => {
    draw(<Page />, { at: "/queue" });
    act(() => useAgentShows.getState().heard(show({ draft: "zz-draft" }, { browser: "zz-another-browser" })));
    await new Promise((r) => setTimeout(r, 50));
    expect(at()).toBe("/queue");
    expect(answers).toEqual([]);
    expect(newest()).toBeUndefined();
  });
});
