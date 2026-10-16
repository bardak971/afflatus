import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Clip } from "../../src/api";
import { AudioPlayer } from "../../src/AudioPlayer";
import { claimPlayback } from "../../src/mediaControls";
import { Player } from "../../src/timeline/Player";
import { draw } from "./render";

const clip = {
  id: "zz-test-clip", kind: "video", recipe: null, joined: "cut", atMs: 0, lengthMs: 4000, inputs: {}, music: null, sound: "own", volume: 100, fill: false, transition: null,
  take: { id: "zz-test-take", asset: { id: "zz-test-video", kind: "video", mime: "video/mp4", fps: 24, durationMs: 4000, width: 640, height: 360 }, headMs: 0, tailMs: 0, startMs: 0, endMs: 4000, roomMs: 4000 },
} as unknown as Clip;

describe("the timeline's player, drawn", () => {
  it("stays paused when Space was pressed twice before the clip's video knew its length (W-3)", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const props = { clips: [clip], music: null, frame: null, onPlaying: () => {}, onTime: () => {}, preview: null };
    const { rerender, container } = draw(<Player {...props} playing={false} />);
    const el = container.querySelector("video")!;
    // a video just put on the page: nothing read of it yet
    Object.defineProperty(el, "readyState", { configurable: true, get: () => 0 });
    rerender(<Player {...props} playing />);
    rerender(<Player {...props} playing={false} />);
    // its metadata comes once it was paused again: it does not start, with its sound, under a paused editor
    fireEvent(el, new Event("loadedmetadata"));
    expect(play).not.toHaveBeenCalled();
    // played and left to load, it starts once it can
    rerender(<Player {...props} playing />);
    fireEvent(el, new Event("loadedmetadata"));
    expect(play).toHaveBeenCalledOnce();
  });
});

describe("the audio player, drawn", () => {
  it("is no longer the one that plays once it is gone from the screen (W-14)", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const { container, unmount } = draw(<AudioPlayer src="/zz-test.mp3" name="zz-test sound" />);
    const el = container.querySelector("audio")!;
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    unmount();
    // another sound plays: the one gone from the page is not reached for (the module had kept it, never let go)
    const pause = vi.spyOn(el, "pause");
    claimPlayback(document.createElement("audio"));
    expect(pause).not.toHaveBeenCalled();
  });
});
