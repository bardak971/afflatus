import { describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { motionSlots } from "../src/motionPicture";

describe("a Motion transfer's picture made from its driving video", () => {
  it("is offered on a form with a picture that moves and a driving video of which a part is taken, not on others", () => {
    const motion = motionSlots(recipeById("scail.motion")!.inputs);
    expect(motion?.picture.id).toBe("picture");
    expect(motion?.driving.id).toBe("driving");
    // an Edit (a source picture, no video) and a swap (a source video, no picture of its own) have none
    expect(motionSlots(recipeById("qwen21.edit")!.inputs)).toBeNull();
    expect(motionSlots(recipeById("h3.swap")!.inputs)).toBeNull();
  });
});

describe("the Inputs tabs while something is dragged", () => {
  it("keeps the tab open when it takes what is dragged, else brings forward the one that does", async () => {
    const { tabWhileDragging } = await import("../src/recipeForm/InputsPart");
    // a picture dragged with References open, both taking pictures: References stays (it went to Frames)
    expect(tabWhileDragging("references", true, true)).toBe("references");
    expect(tabWhileDragging("frames", true, true)).toBe("frames");
    // only one takes it: that one
    expect(tabWhileDragging("references", true, false)).toBe("frames");
    expect(tabWhileDragging("frames", false, true)).toBe("references");
    // nothing dragged: the one open
    expect(tabWhileDragging("references", false, false)).toBe("references");
  });
});
