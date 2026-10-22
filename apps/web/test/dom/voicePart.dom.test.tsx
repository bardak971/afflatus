import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { inspectorProps, overviewProps, trackProps } from "../../src/timeline/editorProps";
import { useTimelineEditor, type LoadedEditor } from "../../src/timeline/useTimelineEditor";
import { fakeApi, later } from "./fakeApi";
import { draw } from "./render";

/**
 * A voice given to a Lip sync clip: its Audio cell's drop and its menu (Choose a recording, Open an audio file) on the track,
 * Needs a look's row, and the clip's own Recording field. Each saves the clip's form at once; the server works out the part
 * of the recording it takes (Timelines.voicePart) and answers with the form as kept, which the band and the Recording
 * chapter read at once, not "0:00.0–0:00.0".
 */

const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }, { id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds" } }],
  traits: { sound: true },
} as unknown as RecipeInfo;

const voiceless = { id: "b", kind: "video", recipe: lipSync.id, joined: "cut", join: null, atMs: 0, lengthMs: 0, inputs: { description: "zz-test: a person talks" }, music: null, take: null, takes: [], sound: "own", volume: 100, pictures: [] } as unknown as Clip;

/** The editor over a timeline of one Lip sync clip without a voice; the server keeps what it is sent, with the voice's part. */
async function editor() {
  let tl = { id: "zz-test-voice", name: "zz-test voice", clips: [voiceless], durationMs: 0, music: null, source: null, recordings: [] } as unknown as Timeline;
  fakeApi.on("GET /timelines/:id", () => tl);
  fakeApi.on("GET /recipes", { families: [], recipes: [lipSync] });
  fakeApi.on("PATCH /clips/:id", ({ body }) => {
    const inputs = { ...(body as { inputs: Record<string, unknown> }).inputs, recordingStart: 0, recordingSeconds: 7 };
    tl = { ...tl, clips: tl.clips.map((c) => (c.id === "b" ? { ...c, inputs } : c)) };
    return { ok: true, inputs };
  });
  let seen!: ReturnType<typeof useTimelineEditor>;
  function Editor() {
    seen = useTimelineEditor(tl.id);
    return null;
  }
  draw(<Editor />);
  await waitFor(() => expect(seen.t && seen.videoRecipes.length).toBeTruthy());
  return { e: () => seen as LoadedEditor, clip: () => seen.shown!.clips.find((c) => c.id === "b")! };
}

/**
 * The voice given by `give`, saved at once: on a clock that stands still short of the half-second autosave, so the save
 * sent is the one asked at once and never the autosave's, however slow the run; then the voice's part as the Recording
 * chapter says it, once the save is answered.
 */
async function partSaid(e: () => LoadedEditor, clip: () => Clip, give: () => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(give);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(fakeApi.calls("PATCH", "/clips/b")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
  expect(fakeApi.calls("PATCH", "/clips/b")[0]!.body).toMatchObject({ inputs: { recording: "zz-test-tone" } });
  await waitFor(() => expect(clip().inputs).toMatchObject({ recording: "zz-test-tone", recordingStart: 0, recordingSeconds: 7 }));
  const r = inspectorProps(e(), clip()).fromRecording!;
  expect([r.fromMs, r.toMs, r.part]).toEqual([0, 7000, { startMs: 0, seconds: 7 }]);
}

describe("a voice given to a Lip sync clip", () => {
  it("dropped on its Audio cell, or chosen or opened from its menu, takes its part at once", async () => {
    const { e, clip } = await editor();
    await partSaid(e, clip, () => trackProps(e()).onVoice!(clip(), "zz-test-tone"));
  });

  it("chosen from Needs a look's row, takes its part at once", async () => {
    const { e, clip } = await editor();
    await partSaid(e, clip, () => overviewProps(e()).onVoice("b", "zz-test-tone"));
  });

  it("set in its Recording field, takes its part at once", async () => {
    const { e, clip } = await editor();
    await partSaid(e, clip, () => inspectorProps(e(), clip()).onInputs({ ...clip().inputs, recording: "zz-test-tone" }));
  });
});

describe("a voice's part worked out while the form is typed", () => {
  it("is laid over what was typed meanwhile: the next save does not send the part from before the voice", async () => {
    // a clip that has a voice and its part (4.7 + 5.5): the server, as Timelines.voiceAsked does, works out the part of a
    // voice new to it whose part was sent unchanged, and keeps any other part it is sent
    const voiced = { ...voiceless, inputs: { ...voiceless.inputs, recording: "zz-test-old", recordingStart: 4.7, recordingSeconds: 5.5 } } as unknown as Clip;
    let tl = { id: "zz-test-voice", name: "zz-test voice", clips: [voiced], durationMs: 0, music: null, source: null, recordings: [] } as unknown as Timeline;
    const slow = later<void>();
    fakeApi.on("GET /timelines/:id", () => tl);
    fakeApi.on("GET /recipes", { families: [], recipes: [lipSync] });
    fakeApi.on("PATCH /clips/:id", async ({ body }) => {
      const sent = (body as { inputs: Record<string, unknown> }).inputs;
      const was = tl.clips[0]!.inputs;
      const fresh = sent.recording !== was.recording && sent.recordingStart === was.recordingStart && sent.recordingSeconds === was.recordingSeconds;
      // the first reading of a sound's pauses takes a while
      if (fresh) await slow.promise;
      const inputs = fresh ? { ...sent, recordingStart: 0, recordingSeconds: 7 } : sent;
      tl = { ...tl, clips: tl.clips.map((c) => (c.id === "b" ? { ...c, inputs } : c)) };
      return fresh ? { ok: true, inputs } : { ok: true };
    });
    let seen!: ReturnType<typeof useTimelineEditor>;
    function Editor() {
      seen = useTimelineEditor(tl.id);
      return null;
    }
    draw(<Editor />);
    await waitFor(() => expect(seen.t && seen.videoRecipes.length).toBeTruthy());
    const e = () => seen as LoadedEditor;
    const clip = () => seen.shown!.clips.find((c) => c.id === "b")!;

    act(() => inspectorProps(e(), clip()).onInputs({ ...clip().inputs, recording: "zz-test-tone" }));
    await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/b")).toHaveLength(1));
    // the scene typed while the server works the part out
    act(() => inspectorProps(e(), clip()).onInputs({ ...clip().inputs, description: "zz-test: a person talks on" }));
    await act(async () => slow.answer());
    await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/b")).toHaveLength(2), { timeout: 2000 });
    expect(fakeApi.calls("PATCH", "/clips/b")[1]!.body).toMatchObject({ inputs: { recording: "zz-test-tone", description: "zz-test: a person talks on", recordingStart: 0, recordingSeconds: 7 } });
    expect(tl.clips[0]!.inputs).toMatchObject({ recordingStart: 0, recordingSeconds: 7 });
    await waitFor(() => expect(clip().inputs).toMatchObject({ description: "zz-test: a person talks on", recordingStart: 0, recordingSeconds: 7 }));
  });
});
