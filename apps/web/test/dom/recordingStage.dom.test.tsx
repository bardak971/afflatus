import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { useEditorPanels } from "../../src/timeline/useEditorPanels";
import { recordingPlace } from "../../src/timeline/recordingPlace";
import type { Slot } from "../../src/timeline/model";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** H3's Video with audio and Lip sync as the editor reads them: a recording laid on Lip sync's sound part by part. */
const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [
    { id: "description", type: "prompt", label: "What happens" },
    { id: "subject", type: "prompt", label: "How they look", optional: true, holds: "subject" },
    { id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds", fits: { frames: 357, fps: 24, pad: 0.12, min: 4, less: ["speechAt"] } } },
  ],
  traits: { sound: true },
} as unknown as RecipeInfo;

const sound = { id: "zz-test-talk", name: "zz-test talk.wav", kind: "audio", durationMs: 15000 };
const take = { id: "zz-test-take", asset: { id: "zz-test-take-video", name: "zz-test take.mp4", kind: "video", durationMs: 5500 }, startMs: 0, endMs: 5500, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0 };
const base = { kind: "video", joined: "continue", join: null, music: null, sound: "own", volume: 100, pictures: [], look: null, chat: [], transition: null, job: null, failed: null, fill: false, pinMirror: [] };
/** A Video with audio clip first (5 s), then the recording's three Lip sync clips: 0–4.7 s, 4.7–10.2 s (rendered), 10.2–15 s. */
const clips = [
  { ...base, id: "zz-test-open", recipe: video.id, joined: "cut", atMs: 0, lengthMs: 5000, inputs: { description: "zz-test a room" }, take: null, takes: [] },
  { ...base, id: "zz-test-a", recipe: lipSync.id, atMs: 5000, lengthMs: 4700, inputs: { description: "zz-test talks", recording: sound.id, recordingStart: 0, recordingSeconds: 4.7 }, take: null, takes: [] },
  { ...base, id: "zz-test-b", recipe: lipSync.id, atMs: 9700, lengthMs: 5500, inputs: { description: "zz-test talks", recording: sound.id, recordingStart: 4.7, recordingSeconds: 5.5 }, take, takes: [take] },
  { ...base, id: "zz-test-c", recipe: lipSync.id, atMs: 15200, lengthMs: 4800, inputs: { description: "zz-test talks on", recording: sound.id, recordingStart: 10.2, recordingSeconds: 4.8 }, take: null, takes: [] },
];
const timeline = {
  id: "zz-test-rec", name: "zz-test recording", width: 576, height: 1024, clips, durationMs: 20_000, look: null, mood: "", music: null, source: null,
  undo: null, redo: null, exporting: null, exported: null, exportFailed: null, folderId: null, projectId: null,
  recordings: [{ asset: sound, parked: 0, parkedTakes: 0, seconds: 5, snap: true }],
} as unknown as Timeline;

/** The editor of the timeline above, its recording's loudness and pauses answered. */
async function editor(tl: Timeline = timeline) {
  fakeApi.on("GET /timelines/:id", tl);
  fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "H3" }], recipes: [video, lipSync] });
  fakeApi.on("GET /assets/:id/motion", { rate: 10, values: Array(150).fill(0), sound: Array.from({ length: 150 }, (_, k) => (k % 50 < 3 ? -60 : -12)), speech: null });
  fakeApi.on("GET /assets/:id/pauses", { pauses: [{ start: 4.6, end: 4.8 }, { start: 7.4, end: 7.6 }, { start: 10.1, end: 10.3 }] });
  const drawn = draw(<TimelineEditor params={{ id: timeline.id }} />, { at: `/timelines/${timeline.id}` });
  const band = await screen.findByRole("button", { name: /^Recording zz-test talk\.wav, 0:00\.0–0:15\.0/ });
  return { ...drawn, band };
}

const click = (el: Element, x = 100) => {
  fireEvent.pointerDown(el, { button: 0, clientX: x });
  fireEvent.pointerUp(el, { clientX: x });
};
const stage = () => document.querySelector("[data-recording-stage]");
const panel = () => screen.queryByRole("complementary", { name: "Recording zz-test talk.wav" });

describe("a recording on the timeline opened like the source (card #61)", () => {
  it("opens on a click on its band: the stage and the column turn to it, the band outlined", async () => {
    const { band } = await editor();
    expect(stage()).toBeNull();
    click(band);
    expect(stage()).toBeTruthy();
    expect(panel()).toBeTruthy();
    expect(band.getAttribute("aria-pressed")).toBe("true");
    expect(band.closest("[data-open]")).toBeTruthy();
  });

  it("is not opened by a drag of its band: the drag slips it", async () => {
    fakeApi.on("POST /timelines/:id/recording/trim", { clips: [], toMs: 15000 });
    // a recording longer than its clips use: slipped, a later part of it is taken
    const { band } = await editor({ ...timeline, recordings: [{ asset: { ...sound, durationMs: 20_000 }, parked: 0, parkedTakes: 0, seconds: 5, snap: true }] } as unknown as Timeline);
    fireEvent.pointerDown(band, { button: 0, clientX: 100 });
    fireEvent.pointerMove(band, { clientX: 60 });
    fireEvent.pointerUp(band, { clientX: 60 });
    // taken as a slip: its start moved past a rendered take is asked first, in its first clip's Recording chapter
    expect(await screen.findByText(/cuts its clips again:/)).toBeTruthy();
    expect(stage()).toBeNull();
    expect(panel()).toBeNull();
  });

  it("closes the source when it opens, and is closed when the source opens", () => {
    const { result } = renderHook(() => useEditorPanels());
    act(() => result.current.openSource());
    act(() => result.current.openRecording(sound.id));
    expect([result.current.sourceOpen, result.current.recordingOpen]).toEqual([false, sound.id]);
    act(() => result.current.openSource());
    expect([result.current.sourceOpen, result.current.recordingOpen]).toEqual([true, null]);
    act(() => result.current.openRecording(sound.id));
    act(() => result.current.select("zz-test-a"));
    expect([result.current.selected, result.current.recordingOpen]).toEqual(["zz-test-a", null]);
  });

  it("sets its Out with O at the moment of it heard on the stage", async () => {
    fakeApi.on("POST /timelines/:id/recording/trim", { clips: [], toMs: 6000 });
    const { band } = await editor();
    click(band);
    const wave = screen.getByRole("slider", { name: /^The recording/ });
    wave.getBoundingClientRect = () => ({ left: 0, width: 1500, top: 0, height: 100, right: 1500, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(wave, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(wave, { pointerId: 1 });
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/trim").map((c) => c.body)).toEqual([{ asset: sound.id, fromMs: 0, toMs: 6000 }]));
  });

  it("gives the clips' player back on Esc, and on a click on a clip (that clip opened)", async () => {
    const { band } = await editor();
    click(band);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(stage()).toBeNull());
    expect(panel()).toBeNull();
    click(band);
    expect(stage()).toBeTruthy();
    fireEvent.click(within(panel()!).getByRole("button", { name: /^Clip 4,/ }));
    await waitFor(() => expect(stage()).toBeNull());
    expect(panel()).toBeNull();
  });

  it("draws its clips' parts on the stage, the pauses it was cut at, and those not used faint", async () => {
    const { band } = await editor();
    click(band);
    const parts = [...document.querySelectorAll("[data-part]")].map((p) => p.textContent);
    expect(parts).toEqual(["Clip 2 · 4.7 s", "Clip 3 · 5.5 s", "Clip 4 · 4.8 s"]);
    await waitFor(() => expect(document.querySelectorAll('[data-pause="unused"]')).toHaveLength(1));
    expect(document.querySelectorAll('[data-pause="used"]')).toHaveLength(2);
  });

  it("shows the take of the clip under the playhead behind the sound (state B), and none where the clip is empty", async () => {
    const { band } = await editor();
    click(band);
    expect(screen.queryByLabelText(/take under the sound$/)).toBeNull();
    // the playhead on the rendered clip 3 (4.7–10.2 s of the recording): its take behind
    const wave = screen.getByRole("slider", { name: /^The recording/ });
    wave.getBoundingClientRect = () => ({ left: 0, width: 1500, top: 0, height: 100, right: 1500, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(wave, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(wave, { pointerId: 1 });
    expect(screen.getByLabelText("Clip 3's take under the sound")).toBeTruthy();
    expect(screen.getByText("take 1 under the sound")).toBeTruthy();
    expect(screen.getByText(/0:06\.0 of 15\.0 s · in clip 3/)).toBeTruthy();
  });

  describe("its panel", () => {
    it("lists its clips with their parts and takes, In → Out, the model and what they share", async () => {
      const { band } = await editor();
      click(band);
      const p = within(panel()!);
      expect(p.getAllByRole("button", { name: /^Clip \d,/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Clip 2, 0:00.0–0:04.7, empty",
        "Clip 3, 0:04.7–0:10.2, take 1",
        "Clip 4, 0:10.2–0:15.0, empty",
      ]);
      expect((p.getByLabelText("In (s of the recording)") as HTMLInputElement).value).toBe("0.0");
      expect((p.getByLabelText("Out (s of the recording)") as HTMLInputElement).value).toBe("15.0");
      expect(p.getByText("H3 · Lip sync")).toBeTruthy();
      expect(p.getByRole("radio", { name: "Clip 1 · seamless" }).getAttribute("aria-checked")).toBe("true");
      // the scene differs from clip to clip: said so; how they look is the same (empty) in all
      expect((p.getByLabelText("What happens") as HTMLTextAreaElement).placeholder).toMatch(/^Each clip has its own/);
    });

    it("trims the recording from In → Out, as its band's edges do", async () => {
      fakeApi.on("POST /timelines/:id/recording/trim", { clips: [], toMs: 12000 });
      const { band, user } = await editor();
      click(band);
      const out = within(panel()!).getByLabelText("Out (s of the recording)");
      await user.clear(out);
      await user.type(out, "12{Enter}");
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/trim").map((c) => c.body)).toEqual([{ asset: sound.id, fromMs: 0, toMs: 12000 }]));
    });

    it("renders the clips that have nothing to play: Render 2 clips sends clips 2 and 4", async () => {
      fakeApi.on("POST /timelines/:id/render", { ids: ["zz-test-job-1", "zz-test-job-2"] });
      const { band, user } = await editor();
      click(band);
      await user.click(within(panel()!).getByRole("button", { name: "Render 2 clips" }));
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/render")).toHaveLength(1));
      const sent = fakeApi.calls("POST", "/timelines/zz-test-rec/render")[0]!.body as { clips: Array<{ id: string }> };
      expect(sent.clips.map((c) => c.id)).toEqual(["zz-test-a", "zz-test-c"]);
    });

    it("cuts it again at another length, asked first as a rendered take would go, and gives what they share to all", async () => {
      // the clips made anew (here read back as they were): the panel stays open on them, no clip of them selected
      fakeApi.on("POST /timelines/:id/recording/cut", { clips: ["zz-test-a", "zz-test-c"] });
      fakeApi.on("POST /timelines/:id/recording/form", { ok: true });
      const { band, user } = await editor();
      click(band);
      const p = within(panel()!);
      await user.click(p.getByRole("switch", { name: /Snap to pauses/ }));
      expect(p.getByRole("alert").textContent).toMatch(/1 rendered take go to the library/);
      expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut")).toHaveLength(0);
      await user.click(p.getByRole("button", { name: "Change" }));
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut").map((c) => c.body)).toEqual([{ asset: sound.id, seconds: 5, snap: false }]));
      await waitFor(() => expect(fakeApi.calls("GET", "/timelines/zz-test-rec").length).toBeGreaterThan(1));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(panel()).toBeTruthy();
      const look = p.getByLabelText("How they look");
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form").map((c) => c.body)).toEqual([{ asset: sound.id, inputs: { subject: "zz-test round glasses" } }]));
    });
  });
});

/** Where a moment of the recording plays on the track, and the other way round (the stage's playhead). */
describe("a recording's place under its clips", () => {
  /** The clips as the track lays them (a clip not rendered yet has no place of its own): each at `startMs`, `lengthMs` long. */
  const slotsOf = (cs: typeof timeline.clips, at: Array<[number, number]>) => cs.map((clip, index) => ({ clip, index, startMs: at[index]![0], lengthMs: at[index]![1], left: 0, width: 0, planned: !clip.take }) as Slot);
  const laid: Array<[number, number]> = [[0, 5000], [5000, 4700], [9700, 5500], [15_200, 4800]];
  const place = recordingPlace(slotsOf(timeline.clips, laid), [video, lipSync], sound.id, 15000)!;
  it("runs with each clip within its part, and on from the first and the last", () => {
    expect(place.parts.map((p) => [p.number, p.startMs, p.endMs, p.trackMs])).toEqual([[2, 0, 4700, 5000], [3, 4700, 10200, 9700], [4, 10200, 15000, 15200]]);
    expect(place.toTrack(6000)).toBe(11000);
    expect(place.toRecording(11000)).toBe(6000);
    // before the first clip: the recording before its In
    expect(place.toRecording(2000)).toBe(0);
    // a clip that outlasts its words (clip 3 here 200 ms longer than its part): the next part's start meanwhile
    const gap = recordingPlace(slotsOf(timeline.clips, [[0, 5000], [5000, 4700], [9700, 5700], [15_400, 4800]]), [video, lipSync], sound.id, 15000)!;
    expect(gap.toRecording(15_100)).toBe(10_100);
    expect(gap.toRecording(15_300)).toBe(10_200);
    expect(gap.toRecording(15_500)).toBe(10_300);
  });

  it("reads the track's places, not the clips' own (0 for a clip not rendered yet)", () => {
    const unplaced = timeline.clips.map((c) => ({ ...c, atMs: 0, lengthMs: 0 }));
    const p = recordingPlace(slotsOf(unplaced, laid), [video, lipSync], sound.id, 15000)!;
    expect(p.parts.map((x) => [x.trackMs, x.clipFromMs, x.clipToMs])).toEqual([[5000, 5000, 9700], [9700, 9700, 15_200], [15_200, 15_200, 20_000]]);
  });

  it("starts each part after the moment before the words (Speech starts at)", () => {
    const later = timeline.clips.map((c) => (c.id === "zz-test-b" ? { ...c, inputs: { ...c.inputs, speechAt: 0.5 } } : c));
    const p = recordingPlace(slotsOf(later, laid), [video, lipSync], sound.id, 15000)!;
    expect(p.parts[1]!.trackMs).toBe(10200);
    expect(p.toTrack(4700)).toBe(10200);
  });
});
