import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { useParts } from "../../src/recipeForm/Part";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { removalAsk } from "../../src/timeline/removalWords";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A clip removed from a recording or the source cuts its part out (card #75): asked first in the clip's own numbers, the
 * part marked on the band where it was cut (a click brings it back) and on the recording's stage; and Speech starts at greyed
 * inside a run of the recording. The timeline is a fixture; nothing renders.
 */

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [
    { id: "description", type: "prompt", label: "What happens" },
    { id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds", fits: { frames: 357, fps: 24, pad: 0.12, min: 4, less: ["speechAt"] } } },
    { id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", note: "a moment of the clip before the words begin" },
  ],
  traits: { sound: true },
} as unknown as RecipeInfo;

const sound = { id: "zz-test-talk", name: "zz-test talk.wav", kind: "audio", durationMs: 15000 };
const take = (id: string) => ({ id, asset: { id: `${id}-video`, name: "zz-test take.mp4", kind: "video", durationMs: 5500 }, startMs: 0, endMs: 5500, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0 });
const base = { kind: "video", joined: "continue", join: null, music: null, sound: "own", volume: 100, pictures: [], look: null, chat: [], transition: null, job: null, failed: null, fill: false, pinMirror: [] };
/** A Video with audio clip first (5 s), then the recording's three Lip sync clips: 0–4.7 s, 4.7–10.2 s (rendered), 10.2–15 s. */
const clips = [
  { ...base, id: "zz-test-open", recipe: video.id, joined: "cut", atMs: 0, lengthMs: 5000, inputs: { description: "zz-test a room" }, take: null, takes: [] },
  { ...base, id: "zz-test-a", recipe: lipSync.id, atMs: 5000, lengthMs: 4700, inputs: { description: "zz-test talks", recording: sound.id, recordingStart: 0, recordingSeconds: 4.7 }, take: null, takes: [] },
  { ...base, id: "zz-test-b", recipe: lipSync.id, atMs: 9700, lengthMs: 5500, inputs: { description: "zz-test talks", recording: sound.id, recordingStart: 4.7, recordingSeconds: 5.5 }, take: take("zz-test-take-b"), takes: [take("zz-test-take-b")] },
  { ...base, id: "zz-test-c", recipe: lipSync.id, atMs: 15200, lengthMs: 4800, inputs: { description: "zz-test talks on", recording: sound.id, recordingStart: 10.2, recordingSeconds: 4.8 }, take: null, takes: [] },
];
const timeline = {
  id: "zz-test-rec", name: "zz-test recording", width: 576, height: 1024, clips, durationMs: 20_000, look: null, mood: "", music: null, source: null,
  undo: null, redo: null, exporting: null, exported: null, exportFailed: null, folderId: null, projectId: null,
  recordings: [{ asset: sound, parked: 0, parkedTakes: 0, seconds: 5, snap: true, removed: [] }],
} as unknown as Timeline;
const recipes = [video, lipSync];

/** The editor of a timeline, with the questions it asks drawn over it. */
async function editor(tl: Timeline = timeline) {
  fakeApi.on("GET /timelines/:id", tl);
  fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "H3" }], recipes });
  fakeApi.on("GET /assets/:id/motion", { rate: 10, values: Array(150).fill(0), sound: Array(150).fill(-12), speech: null });
  fakeApi.on("GET /assets/:id/pauses", { pauses: [{ start: 4.6, end: 4.8 }, { start: 10.1, end: 10.3 }] });
  const drawn = draw(<><TimelineEditor params={{ id: tl.id }} /><ConfirmHost /></>, { at: `/timelines/${tl.id}` });
  const band = await screen.findByRole("button", { name: /^Recording zz-test talk\.wav, / });
  return { ...drawn, band };
}
const click = (el: Element, x = 100) => {
  fireEvent.pointerDown(el, { button: 0, clientX: x });
  fireEvent.pointerUp(el, { clientX: x });
};
/** A clip opened from the recording's panel (its band clicked, then the clip's row). */
async function openClip(band: Element, n: number) {
  click(band);
  const panel = await screen.findByRole("complementary", { name: "Recording zz-test talk.wav" });
  fireEvent.click(within(panel).getByRole("button", { name: new RegExp(`^Clip ${n},`) }));
}

describe("the words said before a clip of a recording is removed (removalAsk)", () => {
  const ask = (ids: string[], tl: Timeline = timeline) => removalAsk(tl, recipes, ids);

  it("says a clip in the middle cuts its part out, where the recording jumps, and that the clip after starts after a cut", () => {
    expect(ask(["zz-test-b"])).toMatchObject({
      title: "Remove clip 3?",
      text: "Its 5.5 s of “zz-test talk.wav” is cut out: the recording jumps from 0:04.7 to 0:10.2, and clip 4 starts after a cut instead of carrying on. The part is set aside with its takes: Bring back on its mark puts it back.\nUndo brings it all back.",
      yes: "Remove",
    });
    expect(ask(["zz-test-b"])!.help).toMatch(/^A ripple delete, as in a video editor/);
  });

  it("adds that the take after was made carrying on from it, and to render it again", () => {
    const after = { ...timeline, clips: timeline.clips.map((c) => (c.id === "zz-test-c" ? { ...c, take: take("zz-test-take-c"), takes: [take("zz-test-take-c")] } : c)) } as Timeline;
    expect(ask(["zz-test-b"], after)!.text).toContain("\nClip 4's take was made carrying on from clip 3: its start no longer matches. Render clip 4 again for a clean start after the cut.\n");
  });

  it("says the first clip moves In past it, the last moves Out before it", () => {
    expect(ask(["zz-test-a"])!.text).toBe("Clip 2 is the first of “zz-test talk.wav”: In moves to 0:04.7, past its 4.7 s.\nUndo brings it all back.");
    expect(ask(["zz-test-c"])!.text).toBe("Clip 4 is the last of “zz-test talk.wav”: Out moves to 0:10.2, before its 4.8 s. Set aside with its takes, it comes back when Out is moved out again.\nUndo brings it all back.");
  });

  it("lists every clip picked in one question, and asks nothing for a clip of no recording, nor for all of one", () => {
    const both = ask(["zz-test-open", "zz-test-a", "zz-test-c"])!;
    expect(both.title).toBe("Remove 3 clips?");
    expect(both.yes).toBe("Remove 3 clips");
    expect(both.text.split("\n")).toEqual([
      "Clip 2 is the first of “zz-test talk.wav”: In moves to 0:04.7, past its 4.7 s.",
      "Clip 4 is the last of “zz-test talk.wav”: Out moves to 0:10.2, before its 4.8 s. Set aside with its takes, it comes back when Out is moved out again.",
      "Undo brings it all back.",
    ]);
    expect(ask(["zz-test-open"])).toBeNull();
    expect(ask(["zz-test-a", "zz-test-b", "zz-test-c"])).toBeNull();
  });
});

describe("a clip of a recording removed in the editor (card #75)", () => {
  it("asks first with its numbers and a \"?\", removes nothing on Cancel, and removes it on Remove", async () => {
    const { band } = await editor();
    fakeApi.on("DELETE /clips/:id", { ok: true });
    await openClip(band, 3);
    fireEvent.keyDown(window, { key: "Delete" });
    const dialog = await screen.findByRole("dialog", { name: "Remove clip 3?" }, { timeout: 3000 });
    expect(dialog.textContent).toContain("the recording jumps from 0:04.7 to 0:10.2");
    expect(within(dialog).getByRole("button", { name: /^Remove clip 3\?: A ripple delete/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fakeApi.calls("DELETE", "/clips/zz-test-b")).toHaveLength(0);
    // pressed again once the removal not gone ahead with has settled (a press meanwhile is one removal, editorKeys.ts)
    const again = await waitFor(() => {
      fireEvent.keyDown(window, { key: "Delete" });
      return screen.getByRole("dialog", { name: "Remove clip 3?" });
    }, { timeout: 3000 });
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fakeApi.calls("DELETE", "/clips/zz-test-b")).toHaveLength(1));
  });

  it("marks the part cut out on the band where it was cut, and brings it back on a click", async () => {
    const cut = {
      ...timeline,
      clips: timeline.clips.filter((c) => c.id !== "zz-test-b").map((c) => (c.id === "zz-test-c" ? { ...c, joined: "cut", atMs: 9700 } : c)),
      recordings: [{ ...timeline.recordings![0]!, removed: [{ before: "zz-test-c", fromMs: 4700, toMs: 10200, clips: 1, takes: 1 }] }],
    } as Timeline;
    fakeApi.on("POST /timelines/:id/removed/back", { ok: true });
    const { band } = await editor(cut);
    const mark = screen.getByRole("button", { name: /^cut · 5\.5 s set aside: 0:04\.7–0:10\.2 cut out here, with 1 clip \(1 rendered\): clip 3 starts after a cut\. Click: bring it back/ });
    // the recording's stage shows the stretch the clips jump over
    click(band);
    const removed = await waitFor(() => {
      const el = document.querySelector("[data-recording-stage] [data-removed]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(removed.textContent).toBe("cut · 5.5 s set aside");
    fireEvent.click(mark);
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-rec/removed/back").map((c) => c.body)).toEqual([{ before: "zz-test-c" }]));
  });

  it("closes the recording on Esc after a box of its panel was typed in: the first Esc gives up the typing, the next closes it", async () => {
    fakeApi.on("POST /timelines/:id/recording/trim", { clips: [], toMs: 15000 });
    const { band } = await editor();
    click(band);
    const box = await screen.findByRole("textbox", { name: "In (s of the recording)" });
    box.focus();
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).not.toBe(box);
    expect((box as HTMLInputElement).value).toBe("0.0");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-recording-stage]")).toBeNull());
    expect(fakeApi.calls("POST", "/timelines/zz-test-rec/recording/trim")).toHaveLength(0);
  });

  it("greys Speech starts at inside a run of the recording, the reason in its \"?\", and leaves it where the run starts", async () => {
    // in the Model chapter: opened before the form is drawn (unfolded while the clips change, its animation was cut short)
    useParts.getState().set("model", true);
    const { band } = await editor();
    await openClip(band, 3);
    const off = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-input-id="speechAt"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(off.hasAttribute("data-off")).toBe(true);
    expect(within(off).getByRole("button", { name: /^Speech starts at: Does not apply here: this clip carries the recording on from clip 2/ })).toBeTruthy();
    expect(within(off).queryByRole("spinbutton")).toBeNull();
    await openClip(band, 2);
    await waitFor(() => expect(document.querySelector('[data-input-id="speechAt"]')?.hasAttribute("data-off")).toBe(false));
  });
});
