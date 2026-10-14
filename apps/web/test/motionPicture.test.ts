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
