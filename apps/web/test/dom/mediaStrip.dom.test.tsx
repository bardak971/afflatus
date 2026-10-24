import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset, Clip, RecipeInfo, Timeline } from "../../src/api";
import { useNewClock } from "../../src/timeline/clock";
import { MediaOverlay } from "../../src/timeline/MediaOverlay";
import { Track } from "../../src/timeline/Track";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const clip = { id: "a", kind: "video", recipe: video.id, joined: "cut", join: null, atMs: 0, lengthMs: 0, inputs: {}, music: null, take: null, takes: [], sound: "own", volume: 100, pictures: [] } as unknown as Clip;
const timeline = { id: "zz-test-media", name: "zz-test media", clips: [clip], durationMs: 5000, music: null, source: null, recordings: [] } as unknown as Timeline;
const picture = (n: number): Asset => ({
  id: `zz-test-picture-${n}`, kind: "image", origin: "upload", name: `zz-test picture ${n}`, mime: "image/png", bytes: 1000, width: 64, height: 64,
  durationMs: null, fps: null, hasSound: false, kept: false, inBin: false, folderId: null, generationId: null, createdAt: "2026-10-24T00:00:00.000Z", path: null,
});

/** The editor's media and its track, side by side as TimelineEditor has them. */
function Editor() {
  const clock = useNewClock();
  return (
    <>
      <MediaOverlay timeline={timeline} placeItems={() => []} />
      <Track
        timeline={timeline} recipes={[video]} pps={40} onZoom={() => {}} selected={null} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
        onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
        onClipSound={() => {}} onMusic={() => {}} onTrim={() => {}} onNewClip={() => {}} onSource={() => {}} onRecording={() => {}}
        range={null} onRange={() => {}}
      />
    </>
  );
}
const shelf = () => screen.queryByRole("region", { name: "Your library" });

describe("the timeline's Media strip, found without being told (card #67)", () => {
  it("opens from a click anywhere on the strip, its word included, and Esc folds it away", async () => {
    fakeApi.on("GET /assets", { items: [], next: null, prev: null });
    const { user } = draw(<Editor />);
    // the strip comes first; the footer's link has the same name
    const strip = screen.getAllByRole("button", { name: "Show the media" })[0]!;
    expect(strip.getAttribute("aria-pressed")).toBe("false");
    // the word, not the icon: the whole strip is the button
    await user.click(screen.getByText("Media"));
    expect(shelf()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Fold the media away" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shelf()).toBeNull();
    // the keyboard: it is a button, so Enter opens it
    screen.getAllByRole("button", { name: "Show the media" })[0]!.focus();
    await user.keyboard("{Enter}");
    expect(shelf()).not.toBeNull();
  });

  it("opens from the track's footer, its \"media\" a link", async () => {
    fakeApi.on("GET /assets", { items: [], next: null, prev: null });
    const { user } = draw(<Editor />);
    const links = screen.getAllByRole("button", { name: "Show the media" });
    // the strip, then the footer's word
    expect(links).toHaveLength(2);
    expect(links[1]!.textContent).toBe("media");
    await user.click(links[1]!);
    expect(shelf()).not.toBeNull();
  });

  it("says how many items the shelf holds once all of them are read, and still says it folded; nothing for none", async () => {
    fakeApi.on("GET /assets", { items: [picture(1), picture(2), picture(3)], next: null, prev: null });
    const { user } = draw(<Editor />);
    const strip = () => screen.getAllByRole("button", { name: /the media/ })[0]!;
    // nothing read yet: no figure rather than a guess
    expect(strip().textContent).toBe("Media");
    await user.click(strip());
    await waitFor(() => expect(strip().textContent).toBe("Media3"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shelf()).toBeNull();
    expect(strip().textContent).toBe("Media3");
    // said in its name as well, not only drawn under the word
    expect(strip().getAttribute("aria-label")).toBe("Show the media, 3 items");
  });
});
