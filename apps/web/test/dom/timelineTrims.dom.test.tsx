import { describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { useTimelineEditor } from "../../src/timeline/useTimelineEditor";
import { fakeApi, later } from "./fakeApi";
import { draw } from "./render";

/** A model that makes a long source window by window, as H3's Motion transfer does. */
const windowed = {
  id: "zz-test.windows", family: "zz-test", title: "zz-test windows", output: "video", summary: "",
  inputs: [{ id: "video", type: "clip", role: "source", label: "Source", window: { start: "sourceStart", seconds: "sourceSeconds" } }],
  traits: { fps: 24, windows: { most: 121, least: 25, carried: 5 } },
} as unknown as RecipeInfo;
const window1 = { id: "zz-test-window", kind: "video", recipe: windowed.id, joined: "cut", atMs: 0, lengthMs: 5000, inputs: { video: { asset: "zz-test-video" }, sourceStart: 2, sourceSeconds: 5 }, music: null, take: null, takes: [] };
/** A timeline whose source is made into its windows already: its stretch changed is a trim. */
const timeline = {
  id: "zz-test-timeline", name: "zz-test timeline", clips: [window1], look: null, mood: null, folderId: null, music: null, durationMs: 5000, undo: "zz-test trim", redo: null,
  source: { asset: "zz-test-video", video: { id: "zz-test-video", name: "zz-test.mp4", kind: "video", durationMs: 20_000 }, atMs: 0, fromMs: 2000, toMs: 8000, recipe: windowed.id, windowMs: 5000, inputs: {}, snap: false, clip: null },
} as unknown as Timeline;

/** The editor of the timeline, the latest of its renders through `now()`. */
async function editor() {
  fakeApi.on("GET /timelines/:id", timeline);
  fakeApi.on("GET /recipes", { families: [], recipes: [windowed] });
  let seen!: ReturnType<typeof useTimelineEditor>;
  function Editor() {
    seen = useTimelineEditor(timeline.id);
    return null;
  }
  draw(<Editor />);
  await waitFor(() => expect(seen.t?.source && seen.videoRecipes.length).toBeTruthy());
  return () => seen;
}

describe("a trim waiting for the one on its way (W-13)", () => {
  /** One trim on its way, its answer held, and a second one asked for meanwhile: it waits. */
  async function oneWaiting(now: () => ReturnType<typeof useTimelineEditor>) {
    const first = later<unknown>();
    fakeApi.on("POST /timelines/:id/source/trim", () => first.promise);
    act(() => void now().stretch.run(2000, 7000));
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim")).toHaveLength(1));
    let waited: boolean | undefined;
    act(() => void now().stretch.run(2000, 6000).then((taken) => (waited = taken)));
    expect(now().stretch.pending).toBe(true);
    return { first, waited: () => waited };
  }

  it("is dropped by an Undo sent meanwhile: it would put back what the Undo took away", async () => {
    const now = await editor();
    const { first, waited } = await oneWaiting(now);
    fakeApi.on("POST /timelines/:id/undo", { undone: "zz-test trim" });
    act(() => now().undo.mutate());
    await waitFor(() => expect(waited()).toBe(false));
    first.answer({ clips: [], toMs: 7000 });
    await waitFor(() => expect(now().undo.isSuccess).toBe(true));
    await waitFor(() => expect(now().stretch.pending).toBe(false));
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim").map((c) => c.body)).toEqual([{ fromMs: 2000, toMs: 7000 }]);
  });

  it("is dropped when the source is taken away: never sent as the settings of a source no longer there", async () => {
    const now = await editor();
    const { first, waited } = await oneWaiting(now);
    fakeApi.on("PATCH /timelines/:id", {});
    act(() => now().removeSource());
    await waitFor(() => expect(waited()).toBe(false));
    first.answer({ clips: [], toMs: 7000 });
    await waitFor(() => expect(now().stretch.pending).toBe(false));
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim")).toHaveLength(1);
    // the removal only: no stretch sent after it
    expect(fakeApi.calls("PATCH", "/timelines/zz-test-timeline").map((c) => c.body)).toEqual([{ source: null }]);
  });

  it("still runs once the one on its way is back, when nothing moved the timeline under it (W-9)", async () => {
    const now = await editor();
    const { first, waited } = await oneWaiting(now);
    fakeApi.on("POST /timelines/:id/source/trim", { clips: [], toMs: 6000 });
    first.answer({ clips: [], toMs: 7000 });
    await waitFor(() => expect(waited()).toBe(true));
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim").map((c) => c.body)).toEqual([{ fromMs: 2000, toMs: 7000 }, { fromMs: 2000, toMs: 6000 }]);
  });
});

describe("Make undone at once (W-17)", () => {
  it("lets go of \"Making…\" once the timeline read back has none of the clips Make made", async () => {
    const before = { ...timeline, clips: [], undo: "zz-test make" } as unknown as Timeline;
    fakeApi.on("GET /timelines/:id", before);
    fakeApi.on("GET /recipes", { families: [], recipes: [windowed] });
    let seen!: ReturnType<typeof useTimelineEditor>;
    function Editor() {
      seen = useTimelineEditor(timeline.id);
      return null;
    }
    draw(<Editor />);
    await waitFor(() => expect(seen.t?.source && seen.videoRecipes.length).toBeTruthy());
    // Make answers, and the timeline it read again is held: the Undo sent at once cancels that read
    const makeRead = later<unknown>();
    fakeApi.on("GET /timelines/:id", () => makeRead.promise);
    fakeApi.on("POST /timelines/:id/source/make", { clips: ["zz-test-window"] });
    act(() => seen.makeSource.run());
    await waitFor(() => expect(fakeApi.calls("GET", "/timelines/zz-test-timeline").length).toBeGreaterThan(1));
    expect(seen.makeSource.pending).toBe(true);
    fakeApi.on("GET /timelines/:id", { ...before, undo: null, redo: "zz-test make" });
    fakeApi.on("POST /timelines/:id/undo", { undone: "zz-test make" });
    act(() => seen.undo.mutate());
    await waitFor(() => expect(seen.t?.redo).toBe("zz-test make"));
    await waitFor(() => expect(seen.makeSource.pending).toBe(false));
  });
});
