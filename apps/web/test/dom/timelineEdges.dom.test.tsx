import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { ContextMenu } from "../../src/ContextMenu";
import { useNewClock } from "../../src/timeline/clock";
import { clipMenuItems, type ClipMenuActions } from "../../src/timeline/menus";
import { layout } from "../../src/timeline/model";
import { MusicLane } from "../../src/timeline/track/MusicLane";
import { SourceLane } from "../../src/timeline/track/SourceLane";
import { TrackRuler } from "../../src/timeline/track/TrackRuler";
import { useClipEdits } from "../../src/timeline/useClipEdits";
import { useOneTrim } from "../../src/timeline/useOneTrim";
import { usePlayhead } from "../../src/timeline/usePlayhead";
import { useRange } from "../../src/timeline/useRange";
import { useTimelineMutations } from "../../src/timeline/useTimelineMutations";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

/** A model whose clips open on a picture and end on one, with a prompt. */
const model = {
  id: "zz-test.pins", family: "zz-test", title: "zz-test pins", output: "video", summary: "",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "first", type: "image", role: "start", label: "First frame", optional: true },
    { id: "last", type: "image", role: "end", label: "Last frame", optional: true },
  ],
} as unknown as RecipeInfo;

const video = { id: "zz-test-take-video", name: "zz-test take", kind: "video", mime: "video/mp4", fps: 24, durationMs: 6000 };
const clip = {
  id: "zz-test-clip", kind: "video", recipe: model.id, joined: "cut", atMs: 0, lengthMs: 5000, inputs: { prompt: "as saved" }, music: null,
  take: { id: "zz-test-take", asset: video, headMs: 0, tailMs: 0, startMs: 0, endMs: 5000, roomMs: 6000 },
} as unknown as Clip;
const timeline = {
  id: "zz-test-timeline", name: "zz-test timeline", clips: [clip], look: null, mood: null, folderId: null, music: null, durationMs: 5000,
  source: { asset: "zz-test-video", video: { id: "zz-test-video", name: "zz-test.mp4" }, atMs: 0, fromMs: 2000, toMs: 8000, recipe: model.id, windowMs: 5000, inputs: {}, snap: false, clip: null },
} as unknown as Timeline;
const none = { data: undefined, isSuccess: false } as never;
const refused = (error: string, status = 409) => jsonAnswer({ error }, status);

/** The editor's clip forms and mutations, the latest of each read through `now()`, the first render's through `first`. */
function rig() {
  const seen: Array<{ edits: ReturnType<typeof useClipEdits>; m: ReturnType<typeof useTimelineMutations>; trim: ReturnType<typeof useOneTrim> }> = [];
  function Editor() {
    const trim = useOneTrim();
    const edits = useClipEdits({ timeline, clips: timeline.clips, recipes: none, setup: none, settings: none, comfyOnline: true });
    const m = useTimelineMutations(timeline.id, {
      timeline, clipsNow: { current: timeline.clips }, recipes: [model], firstRecipe: () => undefined, edits,
      on: { note: () => {}, select: () => {}, unpick: () => {}, writing: () => {}, open: () => {} },
    });
    seen.push({ edits, m, trim });
    return null;
  }
  draw(<Editor />);
  return { now: () => seen.at(-1)!, first: seen[0]! };
}

describe("the timeline editor's mutations, drawn", () => {
  it("says why Make clips from the source and Split source failed (W-2)", async () => {
    fakeApi.on("POST /timelines/:id/source/make", () => refused("zz-test: the source has no stretch to make"));
    fakeApi.on("POST /timelines/:id/source/split", () => refused("zz-test: the playhead is not in the stretch"));
    const { now } = rig();
    act(() => now().m.makeSource.mutate());
    await waitFor(() => expect(now().m.error?.message).toBe("zz-test: the source has no stretch to make"));
    act(() => now().m.splitSource.mutate(3000));
    // the latest failure, not the first of the list
    await waitFor(() => expect(now().m.error?.message).toBe("zz-test: the playhead is not in the stretch"));
  });

  it("keeps what was typed while Loop clip's first frame was being saved (W-5)", async () => {
    const frame = later<unknown>();
    fakeApi.on("POST /assets/:id/frame", () => frame.promise);
    fakeApi.on("PATCH /clips/:id", {});
    const { now } = rig();
    act(() => now().m.loop.mutate(clip));
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-take-video/frame")).toHaveLength(1));
    act(() => now().edits.editInputs(clip, { prompt: "typed meanwhile" }));
    frame.answer({ ...video, id: "zz-test-frame", kind: "image", mime: "image/png" });
    await waitFor(() => expect(now().m.loop.isSuccess).toBe(true));
    expect(now().edits.inputsOf(clip)).toEqual({ prompt: "typed meanwhile", first: "zz-test-frame", last: "zz-test-frame" });
    // and sent so: the form's save carries it (and nothing is left to send once the test is over)
    await act(() => now().edits.save());
    expect(fakeApi.calls("PATCH", "/clips/zz-test-clip").at(-1)?.body).toEqual({ inputs: { prompt: "typed meanwhile", first: "zz-test-frame", last: "zz-test-frame" } });
  });

  it("sends one trim at a time: the last one of each kind asked for meanwhile runs once the first is read back (W-2, W-9)", async () => {
    const answer = later<unknown>();
    fakeApi.on("POST /timelines/:id/source/trim", () => answer.promise);
    fakeApi.on("POST /timelines/:id/recording/trim", { clips: [], toMs: 9000 });
    const { now } = rig();
    const made: string[][] = [];
    // as the editor's runs do: while one is out, kept for later, and run then through the render of that moment
    const source = (fromMs: number, toMs: number): Promise<boolean> => {
      const { trim, m } = now();
      if (trim.busy) return trim.later("source", () => source(fromMs, toMs));
      return trim.run(m.trimSource.mutate, { fromMs, toMs }, (c) => made.push(c));
    };
    const recording = (toMs: number): Promise<boolean> => {
      const { trim, m } = now();
      if (trim.busy) return trim.later("recording:zz-test-talk", () => recording(toMs));
      return trim.run(m.trimRecording.mutate, { asset: "zz-test-talk", fromMs: 0, toMs }, (c) => made.push(c));
    };
    const settled: Array<[string, boolean]> = [];
    const note = (what: string) => (taken: boolean) => void settled.push([what, taken]);
    // two releases heard in the same render (a handle's and its lane's), a typed Out and a recording's trim while the first is out
    act(() => {
      void source(2000, 6000).then(note("first"));
      void source(2000, 6000).then(note("twin"));
    });
    act(() => void source(2000, 5000).then(note("typed")));
    act(() => void recording(9000).then(note("recording")));
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim")).toHaveLength(1));
    // said as under way while they wait
    expect(now().trim.waits("source")).toBe(true);
    expect(now().trim.waits("recording:zz-test-talk")).toBe(true);
    // the twin is the one the typed Out took the place of: never sent
    expect(settled).toEqual([["twin", false]]);
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/recording/trim")).toHaveLength(0);
    fakeApi.on("POST /timelines/:id/source/trim", { clips: [], toMs: 5000 });
    answer.answer({ clips: ["zz-test-window"], toMs: 6000 });
    // read back: the typed Out goes, then the recording's trim once that one is back, each with what was asked last
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/recording/trim")).toHaveLength(1));
    const sent = fakeApi.calls("POST", "/timelines/zz-test-timeline/source/trim");
    expect(sent.map((c) => c.body)).toEqual([{ fromMs: 2000, toMs: 6000 }, { fromMs: 2000, toMs: 5000 }]);
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/recording/trim")[0]!.body).toEqual({ asset: "zz-test-talk", fromMs: 0, toMs: 9000 });
    await waitFor(() => expect(settled).toEqual([["twin", false], ["first", true], ["typed", true], ["recording", true]]));
    expect(made).toEqual([["zz-test-window"], [], []]);
    expect(now().trim.waits("source")).toBe(false);
    expect(now().trim.busy).toBe(false);
  });

  it("takes a trim again once one has failed (W-2)", async () => {
    fakeApi.on("POST /timelines/:id/source/trim", () => refused("zz-test: a window is rendering"));
    const { now } = rig();
    let taken: boolean | undefined;
    act(() => void now().trim.run(now().m.trimSource.mutate, { fromMs: 2000, toMs: 6000 }, () => {}).then((t) => (taken = t)));
    await waitFor(() => expect(now().m.trimSource.isError).toBe(true));
    expect(now().trim.busy).toBe(false);
    // not made: the lane lets go of the stretch it drew
    await waitFor(() => expect(taken).toBe(false));
  });

  it("pins a file onto a clip over the form as it stands when the upload lands, not as it was at the drop (W-4)", async () => {
    fakeApi.on("PATCH /clips/:id", {});
    const { now, first } = rig();
    act(() => now().edits.editInputs(clip, { prompt: "typed during the upload" }));
    // the drop's own callback, from the render the file was dropped in, once the upload is back
    act(() => first.edits.editInputs(clip, (was) => ({ ...was, first: "zz-test-uploaded" })));
    expect(now().edits.inputsOf(clip)).toEqual({ prompt: "typed during the upload", first: "zz-test-uploaded" });
    await act(() => now().edits.save());
  });
});

describe("the range played, drawn", () => {
  it("plays past Out once a range played alone was paused by a click on the picture (W-8)", () => {
    let r!: ReturnType<typeof useRange>;
    let p!: ReturnType<typeof usePlayhead>;
    let playingNow = false;
    let setPlayingNow!: (on: boolean) => void;
    const seek = vi.fn();
    function Transport() {
      const clock = useNewClock();
      const [playing, setPlaying] = useState(false);
      playingNow = playing;
      setPlayingNow = setPlaying;
      const player = { current: { seek, fullscreen: () => {}, where: () => null } };
      r = useRange({ id: timeline.id, clips: timeline.clips, durationMs: 10_000, clock, player, playing, setPlaying, on: { after: () => {}, select: () => {}, note: () => {}, say: () => {}, writeBetween: () => {} } });
      p = usePlayhead({ clock, clips: timeline.clips, endMs: 10_000, player, rangeRef: r.rangeRef, loopRef: r.loopRef, playingRange: r.playingRange, setPlaying });
      return null;
    }
    draw(<Transport />);
    act(() => r.setRange({ inMs: 1000, outMs: 3000 }));
    act(() => r.playRange());
    expect(playingNow).toBe(true);
    // the picture clicked: paused, then played again, both straight through setPlaying
    act(() => setPlayingNow(false));
    act(() => setPlayingNow(true));
    act(() => p.onTime(3000));
    expect(playingNow).toBe(true);
    // a range played with Play still stops at Out
    act(() => setPlayingNow(false));
    act(() => r.toggle());
    act(() => p.onTime(3000));
    expect(playingNow).toBe(false);
  });
});

describe("drags on the track, drawn", () => {
  // the pointer held on an element as a browser holds it
  const captured = new Set<number>();
  const capture = () => {
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation((id: number) => void captured.add(id));
    vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockImplementation((id: number) => captured.has(id));
    vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation((id: number) => void captured.delete(id));
  };

  it("lets go of the music dragged to another part when its save fails (W-10)", async () => {
    capture();
    const withMusic = { ...timeline, music: { asset: { id: "zz-test-song", name: "zz-test song", kind: "audio", durationMs: 60_000 }, volume: 100, fadeInMs: 0, fadeOutMs: 0, duck: false, duckDb: 0, fromMs: 0, startClip: null } } as unknown as Timeline;
    let refuse!: (err: Error) => void;
    const onMusicEdit = vi.fn(() => new Promise((_, no) => (refuse = no)));
    draw(
      <MusicLane timeline={withMusic} slots={layout(withMusic.clips, 50, [model])} pps={50} width={2000} selected={false} over={false}
        measureOf={() => undefined} onDragOver={() => {}} onSelectMusic={() => {}} onMusicEdit={onMusicEdit} />,
    );
    const part = screen.getByRole("button", { name: /Music under clip 1/ });
    fireEvent.pointerDown(part, { button: 0, clientX: 300, pointerId: 1 });
    // the song dragged left by 100 px at 50 px a second: 2 s later in the song plays
    fireEvent.pointerMove(part, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(part, { clientX: 200, pointerId: 1 });
    expect(onMusicEdit).toHaveBeenCalledWith({ music: { fromMs: 2000 } });
    // shown at once, while it is saved
    expect(screen.getByText(/^from 0:02/)).toBeTruthy();
    // refused: the lane draws the part the player and the export use again
    await act(async () => refuse(new Error("zz-test refused")));
    await waitFor(() => expect(screen.queryByText(/^from /)).toBeNull());
  });

  it("forgets a Shift sweep on the ruler that the browser cancelled: the next drag moves the playhead (W-11)", () => {
    capture();
    const onRange = vi.fn();
    const onSeek = vi.fn();
    function Ruler() {
      const clock = useNewClock();
      return <TrackRuler clock={clock} durationMs={5000} slots={layout(timeline.clips, 50, [model])} totalMs={5000} playEnd={5000} pps={50} xOf={(x) => x} range={null} onRange={onRange} onSeek={onSeek} band={null} motion={[]} snapRange={(ms) => ms} />;
    }
    draw(<Ruler />);
    const ruler = screen.getByRole("slider", { name: "Move the playhead" });
    fireEvent.pointerDown(ruler, { shiftKey: true, clientX: 100, pointerId: 1 });
    expect(onRange).toHaveBeenCalledOnce();
    fireEvent.pointerCancel(ruler, { pointerId: 1 });
    captured.clear();
    fireEvent.pointerDown(ruler, { clientX: 120, pointerId: 2 });
    fireEvent.pointerMove(ruler, { clientX: 150, pointerId: 2 });
    expect(onRange).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  it("takes the stage off the source's moment when a drag of its lane is cancelled (W-11)", () => {
    capture();
    const onPeek = vi.fn();
    const onStretch = vi.fn();
    draw(
      <SourceLane timeline={timeline} place={{ atMs: 5000, lengthMs: 20_000, made: false, windows: [], replaces: null }} recipes={[model]} pps={50} selected={false} over={false}
        onDragOver={() => {}} onSelect={() => {}} onStretch={onStretch} onPeek={onPeek} />,
    );
    const lane = screen.getByRole("button", { name: "Source: zz-test.mp4" });
    fireEvent.pointerDown(lane, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 250, pointerId: 1 });
    expect(onPeek).toHaveBeenLastCalledWith(3000);
    fireEvent.pointerCancel(lane, { pointerId: 1 });
    expect(onPeek).toHaveBeenLastCalledWith(null);
    expect(onStretch).not.toHaveBeenCalled();
  });

  it("draws the stretch released until the timeline read back has it, and the old one again when it is not made (W-9)", async () => {
    capture();
    const answers: Array<(taken: boolean) => void> = [];
    const onStretch = vi.fn(() => new Promise<boolean>((done) => answers.push(done)));
    const place = { atMs: 5000, lengthMs: 20_000, made: true, windows: [], replaces: null };
    const lane = (t: Timeline) => (
      <SourceLane timeline={t} place={place} recipes={[model]} pps={50} selected={false} over={false} onDragOver={() => {}} onSelect={() => {}} onStretch={onStretch} onPeek={() => {}} />
    );
    const { rerender } = draw(lane(timeline));
    const pull = (by: number, id: number) => {
      const start = screen.getByRole("separator", { name: "Drag: where the source's stretch starts" });
      fireEvent.pointerDown(start, { button: 0, clientX: 300, pointerId: id });
      fireEvent.pointerMove(start, { clientX: 300 + by, pointerId: id });
      fireEvent.pointerUp(start, { clientX: 300 + by, pointerId: id });
    };
    const from = () => screen.getByText(/^zz-test\.mp4 · from/).textContent;
    // 50 px a second: its start 50 px to the left starts it a second earlier, drawn so while it is sent
    pull(-50, 1);
    expect(onStretch).toHaveBeenLastCalledWith(1000, 8000);
    expect(from()).toBe("zz-test.mp4 · from 1.0 s");
    // dragged again meanwhile: from the stretch drawn, not the one the timeline still has
    pull(-25, 2);
    expect(onStretch).toHaveBeenLastCalledWith(500, 8000);
    expect(from()).toBe("zz-test.mp4 · from 0.5 s");
    // the first one is back: the newer one's drawing is left alone
    await act(async () => answers[0]!(true));
    expect(from()).toBe("zz-test.mp4 · from 0.5 s");
    // the timeline read back (it is, before a trim settles taken), then the second one taken: what the timeline says is drawn
    rerender(lane({ ...timeline, source: { ...timeline.source!, fromMs: 600 } }));
    expect(from()).toBe("zz-test.mp4 · from 0.5 s");
    await act(async () => answers[1]!(true));
    expect(from()).toBe("zz-test.mp4 · from 0.6 s");
    // one not made (asked first, or failed): the stretch the timeline has, at once
    pull(50, 3);
    expect(from()).toBe("zz-test.mp4 · from 1.6 s");
    await act(async () => answers[2]!(false));
    expect(from()).toBe("zz-test.mp4 · from 0.6 s");
  });

  it("lets go of a stretch the server took but left as it was, and drags on from the timeline's (W-11)", async () => {
    capture();
    const answers: Array<(taken: boolean) => void> = [];
    const onStretch = vi.fn((_fromMs: number, _toMs: number) => new Promise<boolean>((done) => answers.push(done)));
    const place = { atMs: 5000, lengthMs: 20_000, made: true, windows: [], replaces: null };
    draw(<SourceLane timeline={timeline} place={place} recipes={[model]} pps={50} selected={false} over={false} onDragOver={() => {}} onSelect={() => {}} onStretch={onStretch} onPeek={() => {}} />);
    const pull = (name: RegExp, x: number, by: number, id: number) => {
      const edge = screen.getByRole("separator", { name });
      fireEvent.pointerDown(edge, { button: 0, clientX: x, pointerId: id });
      fireEvent.pointerMove(edge, { clientX: x + by, pointerId: id });
      fireEvent.pointerUp(edge, { clientX: x + by, pointerId: id });
    };
    // its end a second sooner, which the server snaps back onto a rendered window: taken, and the timeline read back as it was
    pull(/stops in the source/, 700, -50, 1);
    expect(onStretch).toHaveBeenLastCalledWith(2000, 7000);
    await act(async () => answers[0]!(true));
    // its start then pulled a second earlier: with the timeline's end, not the one refused
    pull(/where the source's stretch starts/, 300, -50, 2);
    expect(onStretch).toHaveBeenLastCalledWith(1000, 8000);
  });

  it("springs a trim's end from where it was drawn to the timeline read back, not from the stretch before the trim (W-15)", async () => {
    capture();
    // motion allowed, and the spring held where a jump leaves it (no frame runs): the end is drawn where the spring starts
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("no-preference"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const answers: Array<(taken: boolean) => void> = [];
    const onStretch = vi.fn(() => new Promise<boolean>((done) => answers.push(done)));
    const place = { atMs: 5000, lengthMs: 20_000, made: true, windows: [], replaces: null };
    let readBack!: (t: Timeline) => void;
    // as the editor does: the timeline read back reaches the lane with the render after the settle
    function Lane() {
      const [t, setT] = useState(timeline);
      readBack = setT;
      return <SourceLane timeline={t} place={place} recipes={[model]} pps={50} selected={false} over={false} onDragOver={() => {}} onSelect={() => {}} onStretch={onStretch} onPeek={() => {}} />;
    }
    draw(<Lane />);
    const end = () => screen.getByRole("separator", { name: /stops in the source/ });
    const endPx = () => parseFloat(end().style.left);
    const pull = (x: number, by: number, id: number) => {
      fireEvent.pointerDown(end(), { button: 0, clientX: x, pointerId: id });
      fireEvent.pointerMove(end(), { clientX: x + by, pointerId: id });
      fireEvent.pointerUp(end(), { clientX: x + by, pointerId: id });
    };
    const settle = (toMs: number) => act(async () => {
      readBack({ ...timeline, source: { ...timeline.source!, toMs } });
      answers.at(-1)!(true);
    });
    // its end a second sooner, taken as asked: drawn where it was let go of, no spring from the old end
    pull(700, -50, 1);
    expect(onStretch).toHaveBeenLastCalledWith(2000, 7000);
    const released = endPx();
    await settle(7000);
    expect(endPx()).toBe(released);
    // a second sooner again, the server's end half a second later than asked: carried from where it was drawn, on the
    // spring, rather than from the end before the trim
    pull(650, -50, 2);
    expect(onStretch).toHaveBeenLastCalledWith(2000, 6000);
    const second = endPx();
    await settle(6500);
    expect(endPx()).toBe(second);
  });

  it("trims once on one release of either of its ends, made or not (W-1)", () => {
    capture();
    for (const made of [false, true]) {
      const onStretch = vi.fn();
      const { unmount } = draw(
        <SourceLane timeline={timeline} place={{ atMs: 5000, lengthMs: 20_000, made, windows: [], replaces: null }} recipes={[model]} pps={50} selected={false} over={false}
          onDragOver={() => {}} onSelect={() => {}} onStretch={onStretch} onPeek={() => {}} />,
      );
      // 50 px a second: the end dragged 50 px to the right stops a second later, the start 50 px to the left starts a second earlier
      const end = screen.getByRole("separator", { name: "Drag: where Motion transfer stops in the source" });
      fireEvent.pointerDown(end, { button: 0, clientX: 600, pointerId: 1 });
      fireEvent.pointerMove(end, { clientX: 650, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 650, pointerId: 1 });
      expect(onStretch).toHaveBeenCalledOnce();
      expect(onStretch).toHaveBeenLastCalledWith(2000, 9000);
      const start = screen.getByRole("separator", { name: "Drag: where the source's stretch starts" });
      fireEvent.pointerDown(start, { button: 0, clientX: 300, pointerId: 2 });
      fireEvent.pointerMove(start, { clientX: 250, pointerId: 2 });
      fireEvent.pointerUp(start, { clientX: 250, pointerId: 2 });
      expect(onStretch).toHaveBeenCalledTimes(2);
      expect(onStretch).toHaveBeenLastCalledWith(1000, 8000);
      unmount();
    }
  });
});

describe("a clip's joins, from its menu (W-12)", () => {
  it("opens the join before it and the one after it: on the selected clip the dots are under its trim edges", () => {
    const first = { ...clip, takes: [clip.take] } as Clip;
    const second = { ...first, id: "zz-test-clip-2", atMs: 5000 } as Clip;
    const third = { ...first, id: "zz-test-clip-3", atMs: 10_000 } as Clip;
    const openJoin = vi.fn();
    const act = { clips: [first, second, third], recipes: [model], inputsOf: (c: Clip) => c.inputs, onClip: () => null, picked: new Set<string>(), pending: {}, openJoin } as unknown as ClipMenuActions;
    draw(<ContextMenu at={{ x: 10, y: 10 }} label="Actions on this clip" head={{ title: "Clip 2" }} items={clipMenuItems(second, act)} onClose={() => {}} />);
    // its joins fold into "Joins" (extend or cut, the join before, the join after): a family of three
    const joins = () => screen.queryByRole("menuitem", { name: /How it meets clip 3/ }) ?? (fireEvent.click(screen.getByRole("menuitem", { name: /^Joins/ })), null);
    joins();
    fireEvent.click(screen.getByRole("menuitem", { name: /How it meets clip 1/ }));
    expect(openJoin).toHaveBeenLastCalledWith("zz-test-clip-2");
    joins();
    fireEvent.click(screen.getByRole("menuitem", { name: /How it meets clip 3/ }));
    expect(openJoin).toHaveBeenLastCalledWith("zz-test-clip-3");
  });
});
