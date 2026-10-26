import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The clips picked with Ctrl + click, when some of them leave the timeline under the pick (an Undo of their add, a removal
 * from another tab): Delete removes the ones still there, and the header counts them (B15). The timeline is a fixture;
 * nothing renders.
 */

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
} as unknown as RecipeInfo;
const base = { kind: "video", recipe: video.id, joined: "cut", join: null, music: null, sound: "own", volume: 100, pictures: [], look: null, chat: [], transition: null, job: null, failed: null, fill: false, pinMirror: [], take: null, takes: [], inputs: { description: "zz-test a room" } };
const clip = (id: string, i: number) => ({ ...base, id, atMs: i * 5000, lengthMs: 5000 });
const timelineOf = (ids: string[]) => ({
  id: "zz-test-picked", name: "zz-test picked", width: 576, height: 1024, clips: ids.map(clip), durationMs: ids.length * 5000, look: null, mood: "", music: null, source: null,
  undo: null, redo: null, exporting: null, exported: null, exportFailed: null, folderId: null, projectId: null, recordings: [],
}) as unknown as Timeline;

describe("clips picked, one of them gone from the timeline (B15)", () => {
  it("removes only the picked clips still there on Delete, and the header counts those", async () => {
    let shown = timelineOf(["zz-test-a", "zz-test-b", "zz-test-c"]);
    fakeApi.on("GET /timelines/:id", () => shown);
    fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test" }], recipes: [video] });
    const removed: unknown[] = [];
    fakeApi.on("POST /timelines/:id/clips/remove", ({ body }) => (removed.push(body), { ok: true }));
    const { client } = draw(<TimelineEditor params={{ id: "zz-test-picked" }} />, { at: "/timelines/zz-test-picked" });
    for (const n of [1, 2, 3]) fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^Clip ${n},`) }), { ctrlKey: true });
    await screen.findByRole("button", { name: /Render picked\s*3/ });
    // the last clip's add undone (here: the timeline read again without it)
    shown = timelineOf(["zz-test-a", "zz-test-b"]);
    await client.invalidateQueries();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Clip 3,/ })).toBeNull());
    await screen.findByRole("button", { name: /Render picked\s*2/ });
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(removed).toEqual([{ ids: ["zz-test-a", "zz-test-b"] }]));
  });
});
