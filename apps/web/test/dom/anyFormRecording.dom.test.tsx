import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A recording's clips in any H3 form (card #72): Lip sync, whose mouth follows its part, and Video with audio, which the
 * recording plays over. Each clip picks its form in the recording's panel, the stage and the band hatch those it plays
 * over, the track says so on them, and a clip's model list under a recording offers only those forms.
 */
const window = { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness", goesOn: "recordingGoesOn", leadIn: "recordingLeadIn", fits: { frames: 357, fps: 24, pad: 0.25, min: 4 } };
const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "A new shot made around a recording.", version: 1,
  inputs: [
    { id: "description", type: "prompt", label: "What happens" },
    { id: "recording", type: "audio", role: "sound", label: "Recording", window: { ...window, fits: { ...window.fits, less: ["speechAt"] } } },
    { id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", showWhen: "recording", advanced: true },
  ],
  traits: { sound: true, continues: "clip", latentNodes: ["zz-test-seam"], fps: 24 },
} as unknown as RecipeInfo;
const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "t2v with its sound.", version: 2,
  inputs: [
    { id: "description", type: "prompt", label: "What happens", placeholder: "zz-test someone talks" },
    { id: "music", type: "prompt", label: "Music", optional: true },
    { id: "seconds", type: "number", label: "Duration", min: 4, max: 15, step: 0.5, default: 5, unit: " s" },
    { id: "recording", type: "audio", role: "sound", label: "Recording", optional: true, internal: true, window },
  ],
  traits: { sound: true, continues: "clip", latentNodes: ["zz-test-seam"], fps: 24 },
} as unknown as RecipeInfo;
/** LTX's two forms under a recording (card #2): its Lip sync, and its Video with audio the recording plays over. */
const ltxLipSync = { ...lipSync, id: "zz-test.ltx-lipsync", family: "zz-ltx", traits: { sound: true, continues: "clip", fps: 25, frameGrid: { step: 8, offset: 1 } } } as unknown as RecipeInfo;
const ltxVideo = { ...video, id: "zz-test.ltx-video", family: "zz-ltx", traits: { sound: true, continues: "clip", fps: 25, frameGrid: { step: 8, offset: 1 } } } as unknown as RecipeInfo;
const wan = { id: "zz-test.wan", family: "zz-wan", title: "Image to video", output: "video", summary: "", version: 1, inputs: [{ id: "description", type: "prompt", label: "Prompt" }], traits: {} } as unknown as RecipeInfo;

const sound = { id: "zz-test-song", name: "zz-test song.wav", kind: "audio", durationMs: 15000 };
const base = { kind: "video", joined: "continue", join: null, music: null, sound: "own", volume: 100, pictures: [], look: null, chat: [], transition: null, job: null, failed: null, fill: false, pinMirror: [], take: null, takes: [] };
/** The song's three clips: Lip sync 0–4.7 s, Video with audio 4.7–10.2 s (the recording plays over it), Lip sync 10.2–15 s. */
const clips = [
  { ...base, id: "zz-test-a", recipe: lipSync.id, joined: "cut", atMs: 0, lengthMs: 4950, inputs: { description: "zz-test sings", recording: sound.id, recordingStart: 0, recordingSeconds: 4.7 } },
  { ...base, id: "zz-test-b", recipe: video.id, atMs: 4950, lengthMs: 5750, inputs: { description: "zz-test listens", seconds: 5, recording: sound.id, recordingStart: 4.7, recordingSeconds: 5.5 } },
  { ...base, id: "zz-test-c", recipe: lipSync.id, atMs: 10700, lengthMs: 5050, inputs: { description: "zz-test sings on", recording: sound.id, recordingStart: 10.2, recordingSeconds: 4.8 } },
];
const timeline = {
  id: "zz-test-any", name: "zz-test any form", width: 576, height: 1024, clips, durationMs: 15750, look: null, mood: "", music: null, source: null,
  undo: null, redo: null, exporting: null, exported: null, exportFailed: null, folderId: null, projectId: null,
  recordings: [{ asset: sound, parked: 0, parkedTakes: 0, seconds: 5, window: 1.5 }],
} as unknown as Timeline;

async function editor(more: RecipeInfo[] = []) {
  fakeApi.on("GET /timelines/:id", timeline);
  fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "H3" }, { id: "zz-wan", name: "Wan 2.2" }, { id: "zz-ltx", name: "LTX 2.3" }], recipes: [lipSync, video, wan, ...more] });
  fakeApi.on("GET /assets/:id/motion", { rate: 10, values: Array(150).fill(0), sound: Array(150).fill(-12), speech: null });
  fakeApi.on("GET /assets/:id/pauses", { pauses: [{ start: 4.6, end: 4.8 }, { start: 10.1, end: 10.3 }] });
  fakeApi.on("PATCH /clips/:id", ({ params }) => ({ id: params.id }));
  const drawn = draw(<TimelineEditor params={{ id: timeline.id }} />, { at: `/timelines/${timeline.id}` });
  const band = await screen.findByRole("button", { name: /^Recording zz-test song\.wav, 0:00\.0–0:15\.0/ });
  return { ...drawn, band };
}
const open = (band: Element) => {
  fireEvent.pointerDown(band, { button: 0, clientX: 100 });
  fireEvent.pointerUp(band, { button: 0, clientX: 100 });
};
const panel = () => screen.getByRole("complementary", { name: "Recording zz-test song.wav" });

describe("a recording's clips in any H3 form (card #72)", () => {
  it("lists each clip's form, changed in place; counts those it plays over; New clips is a real choice", async () => {
    fakeApi.on("POST /timelines/:id/recording/new-clips", { ok: true });
    const { band, user } = await editor();
    open(band);
    const p = within(panel());
    expect(p.getByText(/15\.0 s · under clips 1–3 · 2 lip sync, 1 plays over/)).toBeTruthy();
    // each row: its form, by title (the family is the same for all)
    expect(p.getByRole("button", { name: "Clip 1's form: Lip sync" })).toBeTruthy();
    expect(p.getByRole("button", { name: "Clip 2's form: Video with audio" })).toBeTruthy();
    // clip 3's chip opened: the two forms, each with what the recording does on it and how it meets clip 2
    await user.click(p.getByRole("button", { name: "Clip 3's form: Lip sync" }));
    const list = await screen.findByRole("listbox", { name: "Clip 3's form" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("the mouth follows its part · seamless"),
      expect.stringContaining("plays over · seamless"),
    ]);
    await user.click(within(list).getByRole("option", { name: /Video with audio/ }));
    await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/zz-test-c").map((c) => c.body)).toEqual([{ recipe: video.id }]));
    // New clips: Lip sync until set, then the form a re-cut's new parts are made in
    await user.click(p.getByRole("button", { name: "New clips: H3 · Lip sync" }));
    await user.click(within(await screen.findByRole("listbox", { name: "New clips" })).getByRole("option", { name: /H3 · Video with audio/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-any/recording/new-clips").map((c) => c.body)).toEqual([{ asset: sound.id, recipe: video.id }]));
  });

  it("offers LTX's forms beside H3's (card #2): New clips takes LTX's Lip sync, a clip's form says LTX after H3 is a cut", async () => {
    fakeApi.on("POST /timelines/:id/recording/new-clips", { ok: true });
    const { band, user } = await editor([ltxLipSync, ltxVideo]);
    open(band);
    const p = within(panel());
    // the forms made around a recording first, each family's, then those it plays over
    await user.click(p.getByRole("button", { name: "New clips: H3 · Lip sync" }));
    const list = await screen.findByRole("listbox", { name: "New clips" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("H3 · Lip sync"),
      expect.stringContaining("LTX 2.3 · Lip sync"),
      expect.stringContaining("H3 · Video with audio"),
      expect.stringContaining("LTX 2.3 · Video with audio"),
    ]);
    await user.click(within(list).getByRole("option", { name: /LTX 2\.3 · Lip sync/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-any/recording/new-clips").map((c) => c.body)).toEqual([{ asset: sound.id, recipe: ltxLipSync.id }]));
    // clip 3 after an H3 clip: LTX meets it with a cut, H3 carries on seamlessly
    await user.click(p.getByRole("button", { name: "Clip 3's form: Lip sync" }));
    const forms = await screen.findByRole("listbox", { name: "Clip 3's form" });
    expect(within(forms).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("the mouth follows its part · seamless"),
      expect.stringContaining("the mouth follows its part · a cut"),
      expect.stringContaining("plays over · seamless"),
      expect.stringContaining("plays over · a cut"),
    ]);
  });

  it("hatches the part it plays over on the stage and the band", async () => {
    const { band, container } = await editor();
    open(band);
    const parts = [...container.querySelectorAll<HTMLElement>("[data-part]")];
    expect(parts.map((x) => x.dataset.playsOver ?? null)).toEqual([null, "true", null]);
    expect(parts[1]!.textContent).toMatch(/^Clip 2 · ♫ over · 5\.5 s/);
    expect([...container.querySelectorAll<HTMLElement>("[data-plays-over]")].some((x) => x.getAttribute("data-plays-over") === "2")).toBe(true);
    // the band's tip counts them
    expect(band.getAttribute("data-tip")).toMatch(/under 3 clips \(1 it plays over\)/);
  });

  it("offers only the forms under a recording in a clip's model list, says how to use another, and sets its length by its part", async () => {
    const { band, user } = await editor();
    open(band);
    await user.click(within(panel()).getByRole("button", { name: /^Clip 2, / }));
    await user.click(await screen.findByRole("button", { name: "Model: unfold" }));
    const model = await screen.findByRole("button", { name: "Model: H3 · Video with audio" });
    await user.click(model);
    const list = await screen.findByRole("listbox", { name: "Model" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("H3 · Lip sync"), expect.stringContaining("H3 · Video with audio")]);
    expect(screen.getByText("Other models don't go under a recording yet. To use one here, remove the clip from the recording (its part is cut out, asked first).")).toBeTruthy();
    // the recording's chapter says it plays over this clip
    expect(screen.getAllByText(/Plays over this clip/).length).toBeGreaterThan(0);
    // its Duration greyed with its part's length; What happens in positive words; Music asked to stay empty
    await user.click(screen.getByRole("button", { name: "Output: unfold" }));
    expect(await screen.findByText("5.5 s, its part · set here")).toBeTruthy();
    expect((screen.getByLabelText("What happens") as HTMLTextAreaElement).placeholder).toBe("e.g. She listens, eyes closed, her mouth closed, swaying slowly to the music.");
    // the chapters' unfolding let finish: cut short by the test's end, happy-dom rejects it
    await act(() => new Promise((done) => setTimeout(done, 400)));
  });
});
