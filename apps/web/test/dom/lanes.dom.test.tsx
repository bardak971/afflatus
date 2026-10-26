import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { DRAG_SOUND, DRAG_TYPE } from "../../src/screens/Library";
import { useNewClock, type Clock } from "../../src/timeline/clock";
import { attention } from "../../src/timeline/attention";
import { NEW_CLIP, PAD } from "../../src/timeline/model";
import { Track } from "../../src/timeline/Track";
import { endColumnAt, STRIP } from "../../src/timeline/track/EndColumn";
import { usePlayhead } from "../../src/timeline/usePlayhead";
import { Inspector } from "../../src/timeline/Inspector";
import { useTimelineEditor } from "../../src/timeline/useTimelineEditor";
import { whyTone } from "../../src/format";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** H3's two forms as the lanes see them: Video with audio (its own sound), and Lip sync (a recording laid on its sound). */
const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }, { id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds" } }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const recipes = [video, lipSync];

const clip = (id: string, at: number, recipe = video.id, inputs: Record<string, unknown> = {}) =>
  ({ id, kind: "video", recipe, joined: "cut", join: null, atMs: at, lengthMs: 0, inputs, music: null, take: null, takes: [], sound: "own", volume: 100, pictures: [] }) as unknown as Clip;
const timelineOf = (clips: Clip[]) => ({ id: "zz-test-lanes", name: "zz-test lanes", clips, durationMs: 10_000, music: null, source: null, recordings: [] }) as unknown as Timeline;

/** The track at 40 px a second (a clip not rendered yet stands for 5 s: 200 px), what it was asked written down. */
function track(clips: Clip[], over: Partial<ComponentProps<typeof Track>> = {}) {
  const asked: string[] = [];
  let clock!: Clock;
  function Rig() {
    clock = useNewClock();
    return (
      <Track
        timeline={timelineOf(clips)} recipes={recipes} pps={40} onZoom={() => {}} selected={null} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
        onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
        onClipSound={() => {}} onMusic={(a) => asked.push(`music ${a}`)} onTrim={() => {}} onNewClip={() => {}}
        onSource={(a) => asked.push(`source ${a}`)} onRecording={(a, c) => asked.push(`recording ${a}${c ? ` on ${c}` : ""}`)}
        onVoice={(c, a) => asked.push(`voice ${a} for ${c.id}`)} onRecipe={(c, r) => asked.push(`${c.id} to ${r}`)} onSourceSettings={() => asked.push("source settings")}
        onUpload={() => Promise.resolve(null)}
        range={null} onRange={() => {}}
        {...over}
      />
    );
  }
  return { asked, ...draw(<Rig />) };
}

const px = (el: Element, prop: "left" | "width") => Number.parseFloat((el as HTMLElement).style[prop]);
/** A recording of the library dragged over, then dropped on, an element. */
const dropSound = (el: Element, asset: string) => {
  const dataTransfer = { types: [DRAG_SOUND, DRAG_TYPE], getData: (t: string) => (t === DRAG_TYPE ? asset : ""), files: [], items: [] };
  fireEvent.dragOver(el, { dataTransfer });
  fireEvent.drop(el, { dataTransfer });
};

describe("the end column (the lanes mock, 2026-10-22)", () => {
  it("holds New clip, the voice recording and the long video one under the other, after the last clip", () => {
    const { container } = track([clip("a", 0), clip("b", 5000)]);
    const end = PAD + 2 * 200;
    const cells = ["video", "audio", "source"].map((k) => container.querySelector(`[data-end-column="${k}"]`)!);
    expect(container.querySelector("[data-end-strip]")).toBeNull();
    for (const c of cells) {
      expect(px(c, "left")).toBe(end + PAD);
      expect(px(c, "width")).toBe(NEW_CLIP);
    }
    expect(cells[1]!.textContent).toBe("Drop a voice recording: Lip sync, clip by clip");
    expect(cells[2]!.textContent).toBe("Drop a long video: Motion transfer, window by window");
    // no clip's own Audio cell reaches under the recording's drop, and the empty Source lane no longer starts at 0:00
    for (const n of [1, 2]) {
      const own = screen.getByRole("button", { name: new RegExp(`^Audio of clip ${n}:`) });
      expect(px(own, "left") + px(own, "width")).toBeLessThanOrEqual(px(cells[1]!, "left"));
    }
    expect(screen.queryByLabelText(/^Source: none/)).toBeNull();
  });

  it("is the full column only where all of it fits after the clips, else the strip: after them while it fits there, else pinned at the view's right edge (W-20)", () => {
    // the full column after the clips, in view
    expect(endColumnAt(600, PAD, { left: 0, width: 1000 })).toEqual({ left: 610, pinned: false });
    // the clips end in view, the full column would be cut by the edge: the strip, after them (the column pulled left sat
    // over clip 2's Audio cell)
    expect(endColumnAt(900, PAD, { left: 0, width: 1000 })).toEqual({ left: 910, pinned: true });
    // the strip itself would be cut by the edge: at the edge, over the end of the last clip
    expect(endColumnAt(980, PAD, { left: 0, width: 1000 })).toEqual({ left: 1000 - STRIP, pinned: true });
    expect(endColumnAt(2000, PAD, { left: 0, width: 1000 })).toEqual({ left: 1000 - STRIP, pinned: true });
    // scrolled to the end, the clips' end in view again: after them
    expect(endColumnAt(2000, PAD, { left: 1500, width: 1000 })).toEqual({ left: 2010, pinned: false });
    // not measured yet: after the clips
    expect(endColumnAt(2000, PAD, { left: 0, width: 0 })).toEqual({ left: 2010, pinned: false });
  });

  it("gives Fit all the whole track but for the strip, and shows the strip after the clips it fitted (W-20)", async () => {
    const wide = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    try {
      const zooms: number[] = [];
      // three clips not rendered yet: 15 s, fitted on arriving
      track([clip("a", 0), clip("b", 5000), clip("c", 10_000)], { onZoom: (pps) => zooms.push(pps) });
      await waitFor(() => expect(zooms).toHaveLength(1));
      const room = 1000 - STRIP - PAD * 3;
      expect(zooms[0]).toBeCloseTo(room / 15);
      // where the clips end at that zoom: the strip after them, whole in the view, over none of them
      const end = PAD + room;
      expect(endColumnAt(end, PAD, { left: 0, width: 1000 })).toEqual({ left: end + PAD, pinned: true });
      expect(end + PAD + STRIP).toBeLessThanOrEqual(1000);
    } finally {
      wide.mockRestore();
    }
  });

  it("is a slim strip of icons while pinned, each with its words in the tip, its drop and its menu; the full column once the clips end in view", () => {
    // the view 400 px wide, three clips ending at 610 px: the clips run past it
    const wide = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    try {
      const { container, asked } = track([clip("a", 0), clip("b", 5000), clip("c", 10_000)]);
      const strip = container.querySelector<HTMLElement>("[data-end-strip]")!;
      expect(strip).toBeTruthy();
      expect(px(strip, "left")).toBe(400 - STRIP);
      expect(px(strip, "width")).toBe(STRIP);
      const cells = ["video", "audio", "source"].map((k) => strip.querySelector<HTMLElement>(`[data-end-column="${k}"]`)!);
      expect(cells.map((c) => c.dataset.tip)).toEqual(["New clip", "Drop a voice recording: Lip sync, clip by clip", "Drop a long video: Motion transfer, window by window"]);
      for (const c of cells) {
        expect(c.textContent).toBe("");
        expect(px(c, "width")).toBeGreaterThanOrEqual(24);
        expect(px(c, "width")).toBeLessThan(STRIP);
      }
      // a recording dragged over the mic: its cell widens to say what the drop does; dropped, Lip sync clips after the last one
      const dataTransfer = { types: [DRAG_SOUND, DRAG_TYPE], getData: (t: string) => (t === DRAG_TYPE ? "zz-test-voice" : ""), files: [], items: [] };
      fireEvent.dragOver(cells[1]!, { dataTransfer });
      expect(cells[1]!.textContent).toBe("Drop a voice recording: Lip sync, clip by clip");
      expect(px(cells[1]!, "width")).toBe(NEW_CLIP);
      fireEvent.drop(cells[1]!, { dataTransfer });
      expect(asked).toEqual(["recording zz-test-voice"]);
      fireEvent.contextMenu(cells[2]!);
      expect(screen.getAllByRole("menuitem").map((m) => m.textContent?.trim())).toEqual(["Choose a video from the library…", "Open a video file…", "Motion transfer: how windows are cut…"]);
    } finally {
      wide.mockRestore();
    }
    // a view wide enough for the clips: the full column after them, no strip
    const roomy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2000);
    try {
      const { container } = track([clip("a", 0), clip("b", 5000), clip("c", 10_000)]);
      expect(container.querySelector("[data-end-strip]")).toBeNull();
      const audio = container.querySelector<HTMLElement>('[data-end-column="audio"]')!;
      expect(px(audio, "left")).toBe(PAD + 600 + PAD);
      expect(px(audio, "width")).toBe(NEW_CLIP);
      expect(audio.textContent).toBe("Drop a voice recording: Lip sync, clip by clip");
    } finally {
      roomy.mockRestore();
    }
  });

  it("gives its Audio cell the 🎙 every sound slot has, a drop on it the cell's (card #102)", () => {
    const { container, asked } = track([clip("a", 0)]);
    const mic = screen.getByRole("button", { name: "Record from the microphone: Voice recording" });
    const audio = container.querySelector<HTMLElement>('[data-end-column="audio"]')!;
    // over the cell's right end, inside it
    const at = px(mic.parentElement!, "left");
    expect(at).toBeGreaterThan(px(audio, "left"));
    expect(at + 24).toBeLessThanOrEqual(px(audio, "left") + NEW_CLIP);
    dropSound(mic.parentElement!, "zz-test-voice");
    expect(asked).toEqual(["recording zz-test-voice"]);
  });

  it("adds after the last clip what is dropped on its Audio and Source cells", () => {
    const { container, asked } = track([clip("a", 0)]);
    dropSound(container.querySelector('[data-end-column="audio"]')!, "zz-test-voice");
    expect(asked).toEqual(["recording zz-test-voice"]);
  });

  it("says a Video with audio clip's sound before it is rendered, neutral", () => {
    track([clip("a", 0)]);
    const own = screen.getByRole("button", { name: /^Audio of clip 1:/ });
    expect(own.textContent).toBe("own sound, once rendered");
    expect(own.className).not.toMatch(/text-good/);
  });
});

describe("a clip the recording plays over (Video with audio under a recording, card #72)", () => {
  const over = {
    ...video, id: "zz-test.video-over",
    inputs: [...video.inputs, { id: "recording", type: "audio", role: "sound", label: "Recording", optional: true, internal: true, window: { start: "recordingStart", seconds: "recordingSeconds" } }],
  } as unknown as RecipeInfo;

  it("says so on its face, never asks for a voice, and keeps its own Audio cell", () => {
    const clips = [clip("a", 0, lipSync.id, { recording: "zz-test-song" }), clip("b", 5000, over.id, { recording: "zz-test-song", recordingStart: 5, recordingSeconds: 5 }), clip("c", 10_000, over.id)];
    const tl = { ...timelineOf(clips), recordings: [{ asset: { id: "zz-test-song", name: "zz-test song.wav", kind: "audio", durationMs: 15000 }, parked: 0 }] } as unknown as Timeline;
    const { container } = track(clips, { timeline: tl, recipes: [video, lipSync, over] });
    const face = screen.getByRole("button", { name: /^Clip 2,/ });
    expect(within(face).getByText("♫ plays over").closest("[data-tip]")!.getAttribute("data-tip")).toMatch(/^The recording plays over clip 2 unchanged/);
    expect(within(face).queryByText("needs a voice")).toBeNull();
    expect(container.querySelector('[data-voice-cell="b"]')).toBeNull();
    // the same form under no recording: its own sound, nothing said
    expect(within(screen.getByRole("button", { name: /^Clip 3,/ })).queryByText("♫ plays over")).toBeNull();
    expect(within(screen.getByRole("button", { name: /^Clip 1,/ })).queryByText("♫ plays over")).toBeNull();
  });
});

describe("a Lip sync clip without a voice", () => {
  const twoClips = () => [clip("a", 0), clip("b", 5000, lipSync.id, { description: "zz-test: a person talks" })];

  it("says so on its face and in its own Audio cell, amber, and takes a recording there as its voice", () => {
    const { container, asked } = track(twoClips());
    const face = screen.getByRole("button", { name: /^Clip 2,/ });
    const chip = within(face).getByText("needs a voice");
    expect(chip.className).toMatch(/attention/);
    const cell = container.querySelector('[data-voice-cell="b"]')!;
    expect(cell.textContent).toBe("Drop the voice for clip 2 here");
    expect(cell.className).toMatch(/border-dashed/);
    expect(cell.className).toMatch(/attention/);
    dropSound(cell, "zz-test-voice");
    // that clip's voice, nothing else: no Lip sync clips cut from it in its place
    expect(asked).toEqual(["voice zz-test-voice for b"]);
  });

  it("shows the recording's name on its face once it has a voice, neutral", () => {
    const withVoice = [clip("a", 0), clip("b", 5000, lipSync.id, { recording: "zz-test-tone" })];
    const tl = { ...timelineOf(withVoice), recordings: [{ asset: { id: "zz-test-tone", name: "zz-test tone.wav", kind: "audio", durationMs: 5000 }, parked: 0 }] } as unknown as Timeline;
    track(withVoice, { timeline: tl });
    const face = screen.getByRole("button", { name: /^Clip 2,/ });
    expect(within(face).queryByText("needs a voice")).toBeNull();
    expect(within(face).getByText("zz-test tone.wav").closest("[data-tip]")!.className).not.toMatch(/attention/);
  });

  it("is listed in Needs a look on a row of its own, its action the recording's picker", () => {
    const clips = twoClips();
    const rows = attention(clips, { joins: new Map(), renderable: () => false, msOf: () => null, misfit: () => false, why: (c) => (c.id === "a" ? "Write what happens first." : "Drop a voice recording on clip 2's Audio cell, or choose one."), voiceless: (c) => c.id === "b" });
    expect(rows.map((r) => [r.kind, r.ids, r.warn, r.act])).toEqual([
      ["voice", ["b"], false, { do: "voice", clip: "b" }],
      ["missing", ["a"], false, { do: "open", clip: "a", why: "Write what happens first." }],
    ]);
  });
});

describe("a Lip sync clip without a voice, in the column", () => {
  const voiceless = clip("b", 5000, lipSync.id, { description: "zz-test: a person talks" });
  const tl = timelineOf([clip("a", 0), voiceless]);

  it("holds Render back with where the voice goes, said neutral (a to-do)", async () => {
    fakeApi.on("GET /timelines/:id", tl);
    fakeApi.on("GET /recipes", { families: [], recipes });
    let seen!: ReturnType<typeof useTimelineEditor>;
    function Editor() {
      seen = useTimelineEditor(tl.id);
      return null;
    }
    draw(<Editor />);
    await waitFor(() => expect(seen.t && seen.videoRecipes.length).toBeTruthy());
    const b = seen.clips.find((c) => c.id === "b")!;
    const why = seen.ready(b).why!;
    expect(why).toBe("Drop a voice recording on clip 2's Audio cell, or choose one.");
    expect(whyTone(why, undefined)).toBe("todo");
    expect(seen.checks.voiceless(b)).toBe(true);
    expect(seen.checks.voiceless(seen.clips.find((c) => c.id === "a")!)).toBe(false);
  });

  it("is in the inspector's Needs a look, whose Choose a recording opens the Recording picker", async () => {
    fakeApi.on("GET /recipes", { families: [], recipes });
    const inputs: Array<Record<string, unknown>> = [];
    const { user } = draw(
      <Inspector
        timeline={tl} clip={voiceless} index={1} recipes={recipes} stored={voiceless.inputs} whole={null} why="Drop a voice recording on clip 2's Audio cell, or choose one."
        takesMs={null} takesOn={() => null} busy={false} error={null} onInputs={(next) => inputs.push(next)} onRecipe={() => {}} onPatch={() => {}} onRender={() => {}}
        onMenu={() => {}} onRemoveTake={() => {}} onStop={() => {}} onPreview={() => {}} onDesigner={() => {}}
      />,
    );
    expect(screen.getByText("Needs a look · 1")).toBeTruthy();
    expect(screen.getByText("Needs a voice recording")).toBeTruthy();
    // the reason under the form, neutral: a to-do, not a failure
    const reason = screen.getByText(/^Drop a voice recording on clip 2's Audio cell, or choose one\./);
    expect(reason.className).toMatch(/text-ink-2/);
    await user.click(screen.getByRole("button", { name: "Choose a recording…" }));
    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
  });
});

describe("right-click on every lane, empty or full", () => {
  const items = () => screen.getAllByRole("menuitem").map((m) => m.textContent?.trim());

  it("answers on the end column's Source cell", () => {
    const { container, asked } = track([clip("a", 0)]);
    fireEvent.contextMenu(container.querySelector('[data-end-column="source"]')!);
    expect(items()).toEqual(["Choose a video from the library…", "Open a video file…", "Motion transfer: how windows are cut…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Motion transfer/ }));
    expect(asked).toEqual(["source settings"]);
  });

  it("answers on the end column's Audio cell", () => {
    const { container } = track([clip("a", 0)]);
    fireEvent.contextMenu(container.querySelector('[data-end-column="audio"]')!);
    expect(items()).toEqual(["Choose a recording from the library…", "Open an audio file…", "Record from the microphone…"]);
  });

  it("answers on a Lip sync clip's Audio cell without a voice: its voice, or Video with audio", () => {
    const { container, asked } = track([clip("a", 0), clip("b", 5000, lipSync.id)]);
    fireEvent.contextMenu(container.querySelector('[data-voice-cell="b"]')!);
    expect(items()).toEqual(["Choose a recording for clip 2…", "Open an audio file…", "Record from the microphone…", "Switch clip 2 to Video with audio"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch clip 2 to Video with audio" }));
    expect(asked).toEqual([`b to ${video.id}`]);
  });

  it("answers on the empty Music lane", () => {
    track([clip("a", 0)]);
    fireEvent.contextMenu(screen.getByLabelText(/^Music: none/));
    expect(items()).toEqual(["Choose music from the library…", "Open an audio file…"]);
  });

  it("opens a file from the computer through the track's upload, and places it as the lane's kind", async () => {
    const upload = vi.fn(() => Promise.resolve({ id: "zz-test-song", kind: "audio" }));
    const { asked, container } = track([clip("a", 0)], { onUpload: upload });
    fireEvent.contextMenu(screen.getByLabelText(/^Music: none/));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open an audio file…" }));
    const input = container.querySelector<HTMLInputElement>("[data-lane-file]")!;
    expect(input.accept).toBe("audio/*");
    const file = new File(["zz"], "zz-test song.wav", { type: "audio/wav" });
    await act(async () => void fireEvent.change(input, { target: { files: [file] } }));
    expect(upload).toHaveBeenCalledWith(file);
    expect(asked).toEqual(["music zz-test-song"]);
  });
});

describe("the playhead after the timeline gets shorter", () => {
  it("is brought inside it, with the time said (0:08.3 / 0:05.0 after an Undo)", () => {
    let p!: ReturnType<typeof usePlayhead>;
    let clock!: Clock;
    function Rig({ endMs }: { endMs: number }) {
      clock = useNewClock();
      const ref = { current: null };
      p = usePlayhead({ clock, clips: [], endMs, player: { current: null }, rangeRef: ref, loopRef: { current: false }, playingRange: { current: false }, setPlaying: () => {} });
      return null;
    }
    const { rerender } = draw(<Rig endMs={10_000} />);
    act(() => p.setCursor(8300));
    act(() => clock.set(8300));
    expect(p.cursor).toBe(8300);
    rerender(<Rig endMs={5000} />);
    expect(p.cursor).toBe(5000);
    expect(clock.get()).toBe(5000);
    // made longer again (Redo): left where it was brought
    rerender(<Rig endMs={10_000} />);
    expect(p.cursor).toBe(5000);
  });
});

describe("the track with a recording on the stage", () => {
  it("is drawn out to where the recording ends, past its clips: the playhead played past Out stays on the track", () => {
    // two clips (10 s) of a 60 s recording: the stage plays it on to its end
    const { container } = track([clip("a", 0), clip("b", 5000)], { stageEndMs: 60_000 });
    const inner = [...container.querySelectorAll<HTMLElement>("div.relative")].find((d) => d.style.height && d.style.width)!;
    expect(px(inner, "width")).toBe(PAD + 60 * 40 + NEW_CLIP + PAD * 2 + 40);
  });
});
