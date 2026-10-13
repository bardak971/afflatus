import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { InputSpec } from "@afflatus/core";
import { InputsPart } from "../../src/recipeForm/InputsPart";
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
