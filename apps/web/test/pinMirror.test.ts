import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { Clip, RecipeInfo } from "../src/api";
import { parseCommand } from "../src/bar/parse";
import { pinMenuItems } from "../src/timeline/menus";
import { pinMirrorOf, pinMirrors } from "../src/timeline/model";

/** A pinned frame's Mirror, as its right-click menu and the command bar say it. */

const h3: RecipeInfo = {
  id: "h3.video", family: "h3", version: 1, title: "Video", summary: "A clip.", output: "video", traits: null,
  inputs: [
    { id: "prompt", type: "prompt", label: "What happens", style: "sentences" },
    { id: "start", type: "image", label: "First frame", role: "start", optional: true },
    { id: "end", type: "image", label: "Last frame", role: "end", optional: true },
    { id: "mid", type: "image", label: "Keyframe", role: "mid", optional: true, at: "midAt" },
  ] as InputSpec[],
};
const clip = (pinMirror: string[], joined: "cut" | "continue" = "cut") => ({ pinMirror, joined }) as Pick<Clip, "pinMirror" | "joined">;
const inputs = { start: "a", end: "b" };

describe("a pinned frame's Mirror", () => {
  it("is on where the clip flips it, off elsewhere, and nothing where no picture is pinned", () => {
    expect(pinMirrorOf(clip(["start"]), h3, inputs, "start", false)).toEqual({ where: "start", input: "start", asset: "a", on: true, why: null });
    expect(pinMirrorOf(clip(["start"]), h3, inputs, "end", false)).toMatchObject({ on: false, why: null });
    expect(pinMirrorOf(clip(["start"]), h3, inputs, "mid", false)).toBeNull();
    expect(pinMirrorOf(clip([]), undefined, inputs, "start", false)).toBeNull();
  });

  it("is off, with why, on a first frame carried on from the clip before: the join would no longer meet", () => {
    const carried = pinMirrorOf(clip(["start"], "continue"), h3, inputs, "start", true)!;
    expect(carried.on).toBe(false);
    expect(carried.why).toMatch(/join would no longer meet/);
    // a last frame the user pinned is always theirs (it wins over a landing on the clip after)
    expect(pinMirrorOf(clip(["end"], "continue"), h3, inputs, "end", true)).toMatchObject({ on: true, why: null });
  });

  it("lists the frames in the order they play, and its menu item is ticked, or off with its note", () => {
    expect(pinMirrors(clip(["end"]), h3, { ...inputs, mid: "c" }, false).map((m) => [m.where, m.on])).toEqual([["start", false], ["mid", false], ["end", true]]);
    const [on] = pinMenuItems(pinMirrorOf(clip(["end"]), h3, inputs, "end", false)!, { mirror: () => {}, remove: () => {} });
    expect(on).toMatchObject({ label: "Mirror ↔", checked: true, disabled: false });
    const [off] = pinMenuItems(pinMirrorOf(clip(["start"], "continue"), h3, inputs, "start", true)!, { mirror: () => {}, remove: () => {} });
    expect(off).toMatchObject({ checked: false, disabled: true, note: expect.stringMatching(/join/) });
  });

  it("is switched from the command bar: `> mirror pin`, and its off form", () => {
    expect(parseCommand("mirror pin")).toEqual({ cmd: "mirror-pin", off: false });
    expect(parseCommand("mirror pin off")).toEqual({ cmd: "mirror-pin", off: true });
    expect(parseCommand("unmirror pin")).toEqual({ cmd: "mirror-pin", off: true });
    expect(parseCommand("flip frame")).toEqual({ cmd: "mirror-pin", off: false });
  });
});
