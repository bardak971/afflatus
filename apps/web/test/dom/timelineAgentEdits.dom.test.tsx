import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useTimelineEdits, type TimelineEdit } from "../../src/agentEdits";
import type { RecipeInfo, Timeline } from "../../src/api";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { useBanners } from "../../src/store";
import { timelineReader } from "../../src/timelineReads";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A timeline changed from outside by an MCP token (the server's mcpTimelines.ts, a "timelineEdit" live event beside the
 * "timeline" one): the editor open on it reads it again with the user's selection and zoom kept, says the change in a toast
 * whose Undo takes that step alone back, and rings the clips it touched until the user selects them. The timeline is a
 * fixture; nothing renders.
 */

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
} as unknown as RecipeInfo;
const base = { kind: "video", recipe: video.id, joined: "cut", join: null, music: null, sound: "own", volume: 100, pictures: [], look: null, chat: [], transition: null, job: null, failed: null, fill: false, pinMirror: [], take: null, takes: [] };
const clip = (id: string, i: number, description = "zz-test a room") => ({ ...base, id, atMs: i * 5000, lengthMs: 5000, inputs: { description } });
const timelineOf = (clips: unknown[]) => ({
  id: "zz-test-tl", name: "zz-test agent", width: 576, height: 1024, clips, durationMs: clips.length * 5000, look: null, mood: "", music: null, source: null,
  undo: "zz-test last", redo: null, exporting: null, exported: null, exportFailed: null, folderId: null, projectId: null, recordings: [],
}) as unknown as Timeline;

const edit: TimelineEdit = { id: "zz-test-tl", by: "Claude Code", token: "t1", at: "2026-10-27T12:00:00Z", said: "added clip 3 (zz-test-c)", clips: ["zz-test-b", "zz-test-c"], step: "zz-test-step" };
const clipButton = (n: number) => screen.findByRole("button", { name: new RegExp(`^Clip ${n},`) });
const newest = () => useBanners.getState().items.at(-1);

beforeEach(() => {
  useTimelineEdits.setState({ seq: 0, last: null, rings: {} });
  useBanners.setState({ items: [] });
});

describe("an MCP token's change to the timeline open", () => {
  it("shows at once with the selection and zoom kept, rings its clips, and Undo takes that step alone back", async () => {
    let shown = timelineOf([clip("zz-test-a", 0), clip("zz-test-b", 1)]);
    fakeApi.on("GET /timelines/:id", () => shown);
    fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test" }], recipes: [video] });
    const undone: unknown[] = [];
    fakeApi.on("POST /timelines/:id/undo", ({ body }) => (undone.push(body), { undone: "the clip added" }));
    const { client } = draw(<TimelineEditor params={{ id: "zz-test-tl" }} />, { at: "/timelines/zz-test-tl" });
    // the user's own state: clip 1 selected, the track zoomed in
    fireEvent.click(await clipButton(1));
    await waitFor(async () => expect((await clipButton(1)).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: /^Zoom in/ }));
    const width = (await clipButton(1)).style.width;

    // the agent adds a clip and changes clip 2: the events come, the timeline is read again as the live stream reads it
    shown = timelineOf([clip("zz-test-a", 0), clip("zz-test-b", 1, "zz-test a garden"), clip("zz-test-c", 2)]);
    act(() => useTimelineEdits.getState().heard(edit));
    act(() => timelineReader(client)({ tree: true }));
    await clipButton(3);
    expect((await clipButton(1)).getAttribute("aria-pressed")).toBe("true");
    expect((await clipButton(1)).style.width).toBe(width);
    // its clips ringed with the token's name; one the user had not touched
    expect((await clipButton(2)).getAttribute("data-agent")).toBe("Claude Code");
    expect((await clipButton(3)).getAttribute("data-agent")).toBe("Claude Code");
    expect((await clipButton(1)).getAttribute("data-agent")).toBeNull();
    expect(newest()).toMatchObject({ title: "Claude Code changed the timeline", text: "added clip 3 (zz-test-c)", action: { label: "Undo" } });

    // selecting a ringed clip makes it the user's again
    fireEvent.click(await clipButton(2));
    await waitFor(async () => expect((await clipButton(2)).getAttribute("data-agent")).toBeNull());

    // the toast's Undo: that step alone, the rings it left gone
    act(() => newest()!.action!.run());
    await waitFor(() => expect(undone).toEqual([{ step: "zz-test-step" }]));
    await waitFor(async () => expect((await clipButton(3)).getAttribute("data-agent")).toBeNull());
  });

  it("says nothing in another timeline's editor", async () => {
    fakeApi.on("GET /timelines/:id", () => timelineOf([clip("zz-test-a", 0)]));
    fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test" }], recipes: [video] });
    draw(<TimelineEditor params={{ id: "zz-test-tl" }} />, { at: "/timelines/zz-test-tl" });
    await clipButton(1);
    act(() => useTimelineEdits.getState().heard({ ...edit, id: "zz-test-other" }));
    expect(useBanners.getState().items.filter((b) => b.id.startsWith("agent-timeline"))).toEqual([]);
  });
});
