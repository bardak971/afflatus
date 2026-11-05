import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { InputSpec } from "@afflatus/core";
import { framesTabLabel, InputsPart } from "../../src/recipeForm/InputsPart";
import { draw } from "./render";

const recording: InputSpec = { id: "recording", type: "audio", role: "sound", label: "Recording" };
const references: InputSpec = { id: "references", type: "references", label: "Reference images", max: 6, roles: ["person"] };

/** The Inputs part of a form whose recording is required and not chosen yet, its references beside it. */
const part = () => (
  <InputsPart
    frames={[recording]} refs={[references]} framesChosen={0} refsCount={0} chosen="[]" summary="nothing chosen yet" missing q=""
    render={(i) => <p key={i.id}>{i.label} slot</p>}
  />
);

describe("the Inputs part's two tabs", () => {
  it("brings the missing recording forward, and still opens References when it is clicked", async () => {
    const { user } = draw(part());
    expect(screen.getByText("Recording slot")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "References" }));
    expect(screen.getByText("Reference images slot")).toBeTruthy();
    expect(screen.queryByText("Recording slot")).toBeNull();
    // and back
    await user.click(screen.getByRole("radio", { name: "Frames" }));
    expect(screen.getByText("Recording slot")).toBeTruthy();
  });
});

describe("the first tab's name", () => {
  const control: InputSpec = { id: "control", type: "image", role: "guide", label: "Control image", optional: true };
  const source: InputSpec = { id: "source", type: "image", role: "source", label: "Source image" };
  const start: InputSpec = { id: "start", type: "image", role: "start", label: "Start frame" };

  // card #318: SDXL txt2img's Inputs said "Frames | References", its Frames holding the ControlNet image
  it("is Guide in a picture form whose tab holds its control image, Pictures with a source, Frames for a video's frames or a sound", () => {
    expect(framesTabLabel([control])).toBe("Guide");
    expect(framesTabLabel([source, control])).toBe("Pictures");
    expect(framesTabLabel([start])).toBe("Frames");
    expect(framesTabLabel([recording])).toBe("Frames");
    draw(<InputsPart frames={[control]} refs={[references]} framesChosen={0} refsCount={0} chosen="[]" summary="" missing q="" render={(i) => <p key={i.id}>{i.label} slot</p>} />);
    expect(screen.getByRole("radio", { name: "Guide" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Frames" })).toBeNull();
  });
});
