import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { recordingLead, type ClipRecording } from "../../src/timeline/inspector/clipRecording";
import { draw } from "./render";

/** A Lip sync clip made from a recording: its Recording chapter, the stretch its clips are made of (the rethink's trim). */
function chapter(over: Partial<ClipRecording> = {}) {
  const asked: string[] = [];
  const r: ClipRecording = {
    count: 3, over: false, part: { startMs: 4600, seconds: 5.6 }, fromMs: 0, toMs: 15000, trimming: false, ask: null,
    onUses: (from, to) => asked.push(`uses ${from}–${to}`),
    ...over,
  };
  const lead = recordingLead(r);
  draw(<>{lead.node}</>);
  return Object.assign(asked, { lead });
}

describe("a Lip sync clip's Recording chapter", () => {
  it("says the stretch, its clips and this one's part", () => {
    chapter();
    expect(screen.getByText(/0:00\.0–0:15\.0 made into 3 clips · this one 0:04\.6–0:10\.2/)).toBeTruthy();
    expect(screen.getByLabelText("Out (s of the recording)")).toBeTruthy();
  });

  it("asks before a moved start leaves rendered takes behind: Change or Keep it", () => {
    const asked: string[] = [];
    chapter({ ask: { fromMs: 2000, rendered: 1, clips: 3, change: () => asked.push("change"), keep: () => asked.push("keep") } });
    expect(screen.getByRole("alert").textContent).toMatch(/starting at 0:02\.0 cuts its clips again.*3 clips are made anew; 1 rendered take go/);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(asked).toEqual(["keep"]);
  });

  it("on a clip the recording plays over (Video with audio, card #72), says so plainly, the why in its \"?\"", () => {
    const { lead } = chapter({ over: true });
    expect(screen.getByText(/Plays over this clip/).textContent).toBe("Plays over this clip?"); // the status and its "?", the why only in it
    expect(screen.getByRole("button", { name: /^Plays over this clip: Unchanged: the take keeps the recording's part as its sound, and the model's own sound is dropped/ })).toBeTruthy();
    expect(lead.summary).toBe("0:00.0–0:15.0 · 3 clips · plays over");
    expect(lead.help).toMatch(/^The clip stays one of the recording's: its part, its place in the recording's list, the join and the song's hand-over stay/);
    // the stretch's In and Out stay, as on a Lip sync clip
    expect(screen.getByLabelText("Out (s of the recording)")).toBeTruthy();
  });

  it("on a Lip sync clip, says nothing of playing over", () => {
    const { lead } = chapter();
    expect(screen.queryByText(/Plays over this clip/)).toBeNull();
    expect(lead.summary).toBe("0:00.0–0:15.0 · 3 clips");
  });
});
