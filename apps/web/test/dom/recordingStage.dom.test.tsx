import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { Asset, RecipeInfo, Timeline } from "../../src/api";
import type { PlayerHandle } from "../../src/timeline/Player";
import { barsIn, RecordingStage, stretchOf } from "../../src/timeline/RecordingStage";
import { newViewStore, useTrackView } from "../../src/timeline/track/useTrackView";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { useEditorPanels } from "../../src/timeline/useEditorPanels";
import { recordingPlace } from "../../src/timeline/recordingPlace";
import { Slide } from "../../src/timeline/inspector/parts";
import { PAD, type Slot } from "../../src/timeline/model";
import { keepView } from "../../src/timeline/track/KeptZoom";
import { fakeApi, later } from "./fakeApi";
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
  recordings: [{ asset: sound, parked: 0, parkedTakes: 0, seconds: 5, window: 1.5 }],
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

/** Its panel's window typed: ± that many seconds of Clip length. */
async function typeWindow(p: ReturnType<typeof within>, user: ReturnType<typeof draw>["user"], to: string) {
  const box = p.getByLabelText("Window (± s of Clip length)");
  await user.clear(box);
  await user.type(box, `${to}{Enter}`);
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
    const { band } = await editor({ ...timeline, recordings: [{ asset: { ...sound, durationMs: 20_000 }, parked: 0, parkedTakes: 0, seconds: 5, window: 1.5 }] } as unknown as Timeline);
    fireEvent.pointerDown(band, { button: 0, clientX: 100 });
    fireEvent.pointerMove(band, { clientX: 60 });
    fireEvent.pointerUp(band, { clientX: 60 });
    // taken as a slip: its start moved past a rendered take is asked first, in its first clip's Recording chapter
    expect(await screen.findByText(/cuts its clips again:/)).toBeTruthy();
    expect(stage()).toBeNull();
    expect(panel()).toBeNull();
  });

  it("opens at the moment clicked anywhere on its lane, the track centred on it so the stage's view and playhead agree (card #140)", async () => {
    // a 1000 px track, zoomed in when it was left (110 px a second), scrolled to its start: clip 4 is out of view
    let left = 0;
    const sets: number[] = [];
    const wide = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const get = vi.spyOn(HTMLElement.prototype, "scrollLeft", "get").mockImplementation(() => left);
    const set = vi.spyOn(HTMLElement.prototype, "scrollLeft", "set").mockImplementation(function (this: HTMLElement, v: number) {
      left = v;
      sets.push(v);
      this.dispatchEvent(new Event("scroll"));
    });
    try {
      keepView(timeline.id, { pps: 110, fromMs: 0, whole: false });
      const { band } = await editor();
      const lane = band.closest<HTMLElement>("[data-recording-band]")!;
      // the band starts with clip 2, 5 s into the track
      await waitFor(() => expect(lane.style.left).toBe(`${PAD + 5 * 110}px`));
      // pressed 11 s after its start (16 s on the track, 0.8 s into clip 4), far from its name
      click(lane, 11 * 110);
      expect(stage()).toBeTruthy();
      expect(within(stage() as HTMLElement).getByText(/^0:11\.0 of 15\.0 s · in clip 4$/)).toBeTruthy();
      // the track brought 16 s to its middle, and the stage shows what the track shows: the playhead inside it
      await waitFor(() => expect(sets.at(-1)).toBe(PAD + 16 * 110 - 500));
      const head = stage()!.querySelector<HTMLElement>(".bg-ink-strong")!;
      await waitFor(() => expect(parseFloat(head.style.left)).toBeGreaterThan(30));
      expect(parseFloat(head.style.left)).toBeLessThan(70);
      // pressed again, open: the playhead there, the track left where it is (the moment pressed is in view)
      const before = sets.length;
      click(lane, 6 * 110);
      expect(within(stage() as HTMLElement).getByText(/^0:06\.0 of 15\.0 s · in clip 3$/)).toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(sets.length).toBe(before);
    } finally {
      wide.mockRestore();
      get.mockRestore();
      set.mockRestore();
    }
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

  it("is closed when the music opens, by any of its ways (a drop on its lane, Show music, the Overview's button)", () => {
    const { result } = renderHook(() => useEditorPanels());
    act(() => result.current.openRecording(sound.id));
    act(() => result.current.setMusicOpen(true));
    expect([result.current.musicOpen, result.current.recordingOpen]).toEqual([true, null]);
    // the source's panel keeps the column, as it did
    act(() => result.current.openSource());
    act(() => result.current.setMusicOpen(true));
    expect([result.current.musicOpen, result.current.sourceOpen]).toEqual([true, true]);
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

    it("cuts it again at another window, asked first as a rendered take would go, and gives what they share to all", async () => {
      // the clips made anew (here read back as they were): the panel stays open on them, no clip of them selected
      fakeApi.on("POST /timelines/:id/recording/cut", { clips: ["zz-test-a", "zz-test-c"] });
      fakeApi.on("POST /timelines/:id/recording/form", { ok: true });
      const { band, user } = await editor();
      click(band);
      const p = within(panel()!);
      // both its cuts on a pause (4.7, 10.2), said beside the lengths and in its "?"
      await waitFor(() => expect(p.getByText("2 clips on a pause · 4.7, 5.5, 4.8 s")).toBeTruthy());
      await typeWindow(p, user, "0");
      expect(p.getByRole("alert").textContent).toMatch(/1 rendered take go to the library/);
      expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut")).toHaveLength(0);
      await user.click(p.getByRole("button", { name: "Change" }));
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut").map((c) => c.body)).toEqual([{ asset: sound.id, seconds: 5, window: 0 }]));
      await waitFor(() => expect(fakeApi.calls("GET", "/timelines/zz-test-rec").length).toBeGreaterThan(1));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(panel()).toBeTruthy();
      const look = p.getByLabelText("How they look");
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form").map((c) => c.body)).toEqual([{ asset: sound.id, inputs: { subject: "zz-test round glasses" } }]));
    });

    it("holds Clip length while it is cut again, and keeps what was typed to share until it is in the clips' forms", async () => {
      const cut = later<unknown>();
      const shared = later<unknown>();
      fakeApi.on("POST /timelines/:id/recording/cut", () => cut.promise);
      fakeApi.on("POST /timelines/:id/recording/form", () => shared.promise);
      fakeApi.on("PATCH /clips/:id", ({ params }) => ({ id: params.id }));
      const { band, user } = await editor({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, take: null, takes: [] })) } as unknown as Timeline);
      click(band);
      const p = within(panel()!);
      await typeWindow(p, user, "0");
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut")).toHaveLength(1));
      expect(p.getByRole("slider", { name: "Clip length" }).closest("[aria-disabled]")).toBeTruthy();
      cut.answer({ clips: ["zz-test-a", "zz-test-b", "zz-test-c"] });
      await waitFor(() => expect(p.getByRole("slider", { name: "Clip length" }).closest("[aria-disabled]")).toBeNull());
      const look = p.getByLabelText("How they look") as HTMLTextAreaElement;
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form")).toHaveLength(1));
      expect(look.value).toBe("zz-test round glasses");
      // answered, but the clips read back without it (a share that did not take): what was typed stays, for the next blur
      shared.answer({ ok: true, clips: [] });
      await waitFor(() => expect(fakeApi.calls("GET", "/timelines/zz-test-rec").length).toBeGreaterThan(2));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(look.value).toBe("zz-test round glasses");
    });

    it("holds Clip length and its window from the change on, while what was typed is saved before the cut", async () => {
      const saved = later<unknown>();
      fakeApi.on("PATCH /clips/:id", () => saved.promise);
      fakeApi.on("POST /timelines/:id/recording/cut", { clips: ["zz-test-a", "zz-test-b", "zz-test-c"] });
      const { band, user } = await editor({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, take: null, takes: [] })) } as unknown as Timeline);
      // clip 2's scene typed, its save out when the recording's panel cuts it again
      click(band);
      await user.click(within(panel()!).getByRole("button", { name: /^Clip 2,/ }));
      await user.type(await screen.findByLabelText("What happens"), " and laughs");
      click(band);
      const p = within(panel()!);
      await typeWindow(p, user, "0");
      await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/zz-test-a")).toHaveLength(1));
      expect(p.getByRole("slider", { name: "Clip length" }).closest("[aria-disabled]")).toBeTruthy();
      // typed again meanwhile: no second cut with the length from before the first
      await typeWindow(p, user, "2");
      saved.answer({ id: "zz-test-a" });
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut")).toHaveLength(1));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/cut").map((c) => c.body)).toEqual([{ asset: sound.id, seconds: 5, window: 0 }]);
    });

    it("shows the Clip length let go on while it is cut again, not the old one until the read back", () => {
      function Rig() {
        const [busy, setBusy] = useState(false);
        return <Slide label="Clip length" value={5000} min={4000} max={8000} step={100} show={(ms) => `about ${(ms / 1000).toFixed(1)} s`} onCommit={() => setBusy(true)} disabled={busy} />;
      }
      draw(<Rig />);
      fireEvent.keyDown(screen.getByRole("slider", { name: "Clip length" }), { key: "ArrowRight" });
      expect(screen.getByText("about 5.1 s")).toBeTruthy();
    });

    it("gives what they share in the forms' turn: a clip's save sent while the share is out goes after it, with the share laid over it", async () => {
      // the server as a stand-in: the share written in all the clips as it is received, answered when the test says
      const kept = new Map(timeline.clips.map((c) => [c.id, { ...c.inputs } as Record<string, unknown>]));
      const now = () => ({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, inputs: { ...kept.get(c.id)! } })) }) as unknown as Timeline;
      fakeApi.on("PATCH /clips/:id", ({ params, body }) => {
        const b = body as { inputs?: Record<string, unknown> };
        if (b.inputs) kept.set(params.id!, { ...b.inputs });
        return { id: params.id };
      });
      const shared = later<unknown>();
      fakeApi.on("POST /timelines/:id/recording/form", ({ body }) => {
        const { inputs } = body as { inputs: Record<string, unknown> };
        const clips = ["zz-test-a", "zz-test-b", "zz-test-c"].map((id) => {
          kept.set(id, { ...kept.get(id)!, ...inputs });
          return { id, inputs: { ...kept.get(id)! } };
        });
        return shared.promise.then(() => ({ ok: true, clips }));
      });
      const { band, user } = await editor();
      fakeApi.on("GET /timelines/:id", () => now());
      click(band);
      const look = within(panel()!).getByLabelText("How they look");
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form")).toHaveLength(1));
      // clip 2 typed in while the share is out, and its save's half second gone by
      await user.click(within(panel()!).getByRole("button", { name: /^Clip 2,/ }));
      await user.type(await screen.findByLabelText("What happens"), " and laughs");
      await act(() => new Promise((done) => setTimeout(done, 700)));
      act(() => shared.answer(null));
      await waitFor(() => expect(kept.get("zz-test-a")!.description).toBe("zz-test talks and laughs"), { timeout: 3000 });
      expect(kept.get("zz-test-a")!.subject).toBe("zz-test round glasses");
    });

    it("keeps what is typed again while a share is out, through two shares in a row", async () => {
      // the server as a stand-in, each share answered when the test says
      const kept = new Map(timeline.clips.map((c) => [c.id, { ...c.inputs } as Record<string, unknown>]));
      const now = () => ({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, inputs: { ...kept.get(c.id)! } })) }) as unknown as Timeline;
      const answers: Array<() => void> = [];
      fakeApi.on("PATCH /clips/:id", ({ params }) => ({ id: params.id }));
      fakeApi.on("POST /timelines/:id/recording/form", ({ body }) => {
        const { inputs } = body as { inputs: Record<string, unknown> };
        const shared = later<unknown>();
        answers.push(() => {
          const clips = ["zz-test-a", "zz-test-b", "zz-test-c"].map((id) => {
            kept.set(id, { ...kept.get(id)!, ...inputs });
            return { id, inputs: { ...kept.get(id)! } };
          });
          shared.answer({ ok: true, clips });
        });
        return shared.promise;
      });
      const { band, user } = await editor();
      fakeApi.on("GET /timelines/:id", () => now());
      click(band);
      const look = within(panel()!).getByLabelText("How they look") as HTMLTextAreaElement;
      const reads = () => fakeApi.calls("GET", "/timelines/zz-test-rec").length;
      // shared once, then typed again and shared again: the second waits its turn (the forms' turn), the first out
      await user.type(look, "zz-test glasses");
      act(() => look.blur());
      await waitFor(() => expect(answers).toHaveLength(1));
      await user.type(look, " and a hat");
      act(() => look.blur());
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(answers).toHaveLength(1);
      // the first one back and read back: the field keeps the newer text, the second sent then
      let before = reads();
      act(() => answers[0]!());
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(look.value).toBe("zz-test glasses and a hat");
      await waitFor(() => expect(answers).toHaveLength(2));
      before = reads();
      act(() => answers[1]!());
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      expect(look.value).toBe("zz-test glasses and a hat");
      // typed again while a third is out (not left yet): its answer does not wipe what is being typed
      await user.type(look, ", red");
      act(() => look.blur());
      await waitFor(() => expect(answers).toHaveLength(3));
      await user.type(look, " and blue");
      before = reads();
      act(() => answers[2]!());
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(look.value).toBe("zz-test glasses and a hat, red and blue");
      expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form").map((c) => (c.body as { inputs: { subject: string } }).inputs.subject)).toEqual(["zz-test glasses", "zz-test glasses and a hat", "zz-test glasses and a hat, red"]);
    });

    it("gives what they share to a clip typed in just before, whose next save keeps it", async () => {
      // the server as a stand-in: the clips' forms as saved, the shared one written in all of them
      const kept = new Map(timeline.clips.map((c) => [c.id, { ...c.inputs } as Record<string, unknown>]));
      const now = () => ({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, inputs: { ...kept.get(c.id)! } })) }) as unknown as Timeline;
      fakeApi.on("PATCH /clips/:id", ({ params, body }) => {
        const b = body as { inputs?: Record<string, unknown> };
        if (b.inputs) kept.set(params.id!, { ...b.inputs });
        return { id: params.id };
      });
      fakeApi.on("POST /timelines/:id/recording/form", ({ body }) => {
        const { inputs } = body as { inputs: Record<string, unknown> };
        const clips = ["zz-test-a", "zz-test-b", "zz-test-c"].map((id) => {
          kept.set(id, { ...kept.get(id)!, ...inputs });
          return { id, inputs: { ...kept.get(id)! } };
        });
        return { ok: true, clips };
      });
      const { band, user } = await editor();
      fakeApi.on("GET /timelines/:id", () => now());
      // clip 2's scene typed, then the recording's panel: How they look
      click(band);
      await user.click(within(panel()!).getByRole("button", { name: /^Clip 2,/ }));
      const scene = await screen.findByLabelText("What happens");
      await user.type(scene, " and laughs");
      click(band);
      const look = within(panel()!).getByLabelText("How they look");
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(kept.get("zz-test-a")).toMatchObject({ description: "zz-test talks and laughs", subject: "zz-test round glasses" }));
      await waitFor(() => expect(fakeApi.calls("GET", "/timelines/zz-test-rec").length).toBeGreaterThan(2));
      // clip 2 opened again and typed in: its save keeps the shared text, never the form from before it
      await user.click(within(panel()!).getByRole("button", { name: /^Clip 2,/ }));
      await user.type(screen.getByLabelText("What happens"), "!");
      await waitFor(() => expect(kept.get("zz-test-a")!.description).toBe("zz-test talks and laughs!"), { timeout: 3000 });
      expect(kept.get("zz-test-a")!.subject).toBe("zz-test round glasses");
    });

    it("gives what they share to a clip typed in while the share is out, whose waiting save does not put the old text back", async () => {
      const kept = new Map(timeline.clips.map((c) => [c.id, { ...c.inputs } as Record<string, unknown>]));
      const now = () => ({ ...timeline, clips: timeline.clips.map((c) => ({ ...c, inputs: { ...kept.get(c.id)! } })) }) as unknown as Timeline;
      fakeApi.on("PATCH /clips/:id", ({ params, body }) => {
        const b = body as { inputs?: Record<string, unknown> };
        if (b.inputs) kept.set(params.id!, { ...b.inputs });
        return { id: params.id };
      });
      let answer = () => {};
      fakeApi.on("POST /timelines/:id/recording/form", ({ body }) => {
        const { inputs } = body as { inputs: Record<string, unknown> };
        const shared = later<unknown>();
        answer = () => {
          const clips = ["zz-test-a", "zz-test-b", "zz-test-c"].map((id) => {
            kept.set(id, { ...kept.get(id)!, ...inputs });
            return { id, inputs: { ...kept.get(id)! } };
          });
          shared.answer({ ok: true, clips });
        };
        return shared.promise;
      });
      const { band, user } = await editor();
      fakeApi.on("GET /timelines/:id", () => now());
      click(band);
      const look = within(panel()!).getByLabelText("How they look");
      await user.type(look, "zz-test round glasses");
      act(() => look.blur());
      await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/form")).toHaveLength(1));
      // clip 2 typed in while the share is out, its save waiting; then the share comes back
      await user.click(within(panel()!).getByRole("button", { name: /^Clip 2,/ }));
      await user.type(await screen.findByLabelText("What happens"), " and laughs");
      act(() => answer());
      await waitFor(() => expect(kept.get("zz-test-a")!.description).toBe("zz-test talks and laughs"), { timeout: 3000 });
      expect(kept.get("zz-test-a")!.subject).toBe("zz-test round glasses");
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

  it("starts a part after the moment before the words (Speech starts at) where a run starts, never inside one (card #75)", () => {
    const later = timeline.clips.map((c) => (c.id === "zz-test-a" || c.id === "zz-test-b" ? { ...c, inputs: { ...c.inputs, speechAt: 0.5 } } : c));
    const p = recordingPlace(slotsOf(later, laid), [video, lipSync], sound.id, 15000)!;
    expect(p.parts[0]!.trackMs).toBe(5500);
    // clip 3 carries on clip 2's part: its own moment does not apply, the server sends none (TimelinePlan.recordingRun)
    expect(p.parts[1]!.trackMs).toBe(9700);
    expect(p.toTrack(4700)).toBe(9700);
  });

  describe("on the stage", () => {
    const at = (cs: Array<[number, number]>, lengthMs: number | null = 15000) => recordingPlace(slotsOf(timeline.clips, cs), [video, lipSync], sound.id, lengthMs)!;
    const tail: Array<[number, number]> = [[0, 5000], [5000, 4700], [9700, 5700], [15_400, 4800]];
    function stageOf(first: ReturnType<typeof at>) {
      const onTime = vi.fn();
      const ref = createRef<PlayerHandle>();
      const props = { recording: sound as unknown as Asset, playing: false, onPlaying: () => {}, onTime, startAt: 0 };
      const drawn = draw(<RecordingStage ref={ref} {...props} place={first} />);
      return { onTime, ref, redraw: (place: ReturnType<typeof at>) => drawn.rerender(<RecordingStage ref={ref} {...props} place={place} />), drawn };
    }

    it("leaves the playhead where it was put when the timeline is read again (a take landing), and follows the parts that moved", () => {
      const { onTime, ref, redraw } = stageOf(at(tail));
      // put in clip 3's tail: the moment heard is the end of its part, the playhead stays where it was put (editorProps onSeek)
      act(() => ref.current!.seek(15_300));
      onTime.mockClear();
      // read again, nothing moved: the playhead is left alone
      redraw(at(tail));
      expect(onTime).not.toHaveBeenCalled();
      // clip 4 laid 1 s later: the moment heard plays there now, the playhead follows
      redraw(at([[0, 5000], [5000, 4700], [9700, 6700], [16_400, 4800]]));
      expect(onTime).toHaveBeenCalledWith(16_400);
    });

    it("shows the stretch the track shows: all of it when the track shows all its clips, the same stretch when zoomed", () => {
      const p = at(tail);
      // nothing said yet, or every clip of it in view (Fit all): the whole recording, as before
      expect(stretchOf(p, null)).toEqual({ fromMs: 0, toMs: 15000 });
      expect(stretchOf(p, { fromMs: -500, toMs: 22_000 })).toEqual({ fromMs: 0, toMs: 15000 });
      // the track zoomed on clip 3 (9.7 to 15.4 s of the track): its part of the recording, 4.7 to 10.2 s
      expect(stretchOf(p, { fromMs: 9700, toMs: 15_400 })).toEqual({ fromMs: 4700, toMs: 10_200 });
      // zoomed in further than 2 s: 2 s around the middle
      expect(stretchOf(p, { fromMs: 11_000, toMs: 11_500 })).toEqual({ fromMs: 5250, toMs: 7250 });
    });

    it("zoomed with the track: only the parts in view, In and Out said at the side they lie beyond", () => {
      const store = newViewStore();
      const ref = createRef<PlayerHandle>();
      const props = { recording: sound as unknown as Asset, playing: false, onPlaying: () => {}, onTime: () => {}, startAt: 0 };
      const drawn = draw(<RecordingStage ref={ref} {...props} place={at(tail)} view={store} />);
      const parts = () => [...drawn.container.querySelectorAll("[data-part]")].map((e) => e.getAttribute("data-part"));
      const beyond = () => [...drawn.container.querySelectorAll("[data-beyond]")].map((e) => e.textContent);
      expect(parts()).toEqual(["2", "3", "4"]);
      expect(beyond()).toEqual([]);
      act(() => store.set({ fromMs: 9700, toMs: 15_400 }));
      expect(parts()).toEqual(["3"]);
      expect(beyond()).toEqual(["◂ In 0:00.0", "Out 0:15.0 ▸"]);
      // the part fills the stage it is shown on
      const shown = drawn.container.querySelector<HTMLElement>("[data-part='3']")!;
      expect([shown.style.left, shown.style.width]).toEqual(["0%", "100%"]);
      // Fit all: the whole recording again
      act(() => store.set({ fromMs: 0, toMs: 20_000 }));
      expect(parts()).toEqual(["2", "3", "4"]);
    });

    it("says the stretch shown after a zoom once the zoom has scrolled the track, never the new zoom with the old scroll", () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
      vi.stubGlobal("cancelAnimationFrame", () => {});
      try {
        const el = document.createElement("div");
        Object.defineProperty(el, "clientWidth", { value: 1000 });
        el.scrollLeft = 10;
        const said = vi.fn();
        const { rerender } = renderHook(({ pps }) => useTrackView({ current: el }, pps, said), { initialProps: { pps: 100 } });
        expect(said).toHaveBeenLastCalledWith({ fromMs: 0, toMs: 10_000 });
        // zoomed in twice around 5 s at the stage's middle: the zoom asks its scroll for the next frame, then is drawn
        frames.push(() => (el.scrollLeft = 10 + 500));
        rerender({ pps: 200 });
        for (const f of frames.splice(0)) f(0);
        expect(said.mock.calls.map((c) => c[0])).toEqual([{ fromMs: 0, toMs: 10_000 }, { fromMs: 2500, toMs: 7500 }]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("draws the bars of the stretch shown, as tall as the whole recording's loudest makes them", () => {
      const sound = Array.from({ length: 150 }, (_, k) => (k < 50 ? -6 : -30));
      const top = Math.max(...sound.map((db) => (db + 60) / 60));
      // 8 s at 10 measures a second: 80 bars, one a measure, all of the quieter stretch measured against the loudest
      const wave = barsIn(sound, 10, top, { fromMs: 6000, toMs: 14_000 })!;
      expect(wave.bars).toHaveLength(80);
      expect([wave.fromMs, wave.toMs]).toEqual([6000, 14_000]);
      expect(wave.bars.every((v) => Math.abs(v - 30 / 54) < 1e-9)).toBe(true);
    });

    /** Its one clip opening the timeline, In trimmed to 10 s: what lies before In plays before the track's start. */
    const trimmed = () => {
      const c = { ...timeline.clips[1]!, inputs: { ...timeline.clips[1]!.inputs, recordingStart: 10, recordingSeconds: 5 } };
      return recordingPlace(slotsOf([c], [[0, 5000]]), [video, lipSync], sound.id, 15000)!;
    };
    const wide = (el: Element) => (el.getBoundingClientRect = () => ({ left: 0, width: 1500, top: 0, height: 100, right: 1500, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }));

    it("never puts the playhead before the track's start: a click before In stops at the moment heard at 0", () => {
      const { onTime, drawn } = stageOf(trimmed());
      const wave = within(drawn.container).getByRole("slider", { name: /^The recording/ });
      wide(wave);
      onTime.mockClear();
      // 2 s of the recording, which would play 8 s before the track's start
      fireEvent.pointerDown(wave, { button: 0, clientX: 200, pointerId: 1 });
      fireEvent.pointerUp(wave, { pointerId: 1 });
      expect(onTime).toHaveBeenLastCalledWith(0);
      expect(within(drawn.container).getByText(/^0:10\.0 of 15\.0 s/)).toBeTruthy();
      expect(wave.getAttribute("aria-valuemin")).toBe("10000");
    });

    it("plays again from the moment heard at the track's start, not the recording's 0", () => {
      const p = trimmed();
      const ref = createRef<PlayerHandle>();
      const props = { recording: sound as unknown as Asset, onPlaying: () => {}, onTime: () => {}, startAt: 0, place: p };
      const drawn = draw(<RecordingStage ref={ref} {...props} playing={false} />);
      const audio = drawn.container.querySelector("audio")!;
      audio.play = () => Promise.resolve();
      act(() => ref.current!.seek(5000));
      expect(audio.currentTime).toBe(15);
      drawn.rerender(<RecordingStage ref={ref} {...props} playing />);
      expect(audio.currentTime).toBe(10);
    });

    it("moves the playhead with the keys of a slider: a second, five with Shift, Home and End", () => {
      const { onTime, drawn } = stageOf(at(tail));
      const wave = within(drawn.container).getByRole("slider", { name: /^The recording/ });
      expect(wave.tabIndex).toBe(0);
      const now = () => wave.getAttribute("aria-valuenow");
      fireEvent.keyDown(wave, { key: "ArrowRight" });
      expect(now()).toBe("1000");
      fireEvent.keyDown(wave, { key: "ArrowRight", shiftKey: true });
      expect(now()).toBe("6000");
      expect(onTime).toHaveBeenLastCalledWith(11_000);
      fireEvent.keyDown(wave, { key: "ArrowLeft" });
      expect(now()).toBe("5000");
      fireEvent.keyDown(wave, { key: "End" });
      expect(now()).toBe("15000");
      fireEvent.keyDown(wave, { key: "Home" });
      expect(now()).toBe("0");
    });

    it("draws a recording with no length at its start, never NaN %", () => {
      const none = { ...at(tail), lengthMs: 0 };
      const { drawn } = stageOf(none);
      // the playhead's line: at 0 %, where NaN % was dropped by the browser and left it with no place at all
      const line = drawn.container.querySelector<HTMLElement>(".bg-ink-strong.w-0\\.5")!;
      expect(line.style.left).toBe("0%");
    });
  });
});
