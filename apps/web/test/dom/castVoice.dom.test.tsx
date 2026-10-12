import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SoundField } from "../../src/PictureField";
import { draw } from "./render";

/**
 * The voice sample a form's cast adds when it is sent (a person's own): the form's voice field shows it while the form has
 * none of its own, says whose it is, and leaves it to the cast (no Remove); a sample chosen in the form is shown instead.
 */
describe("the voice field of a form with a cast, drawn", () => {
  it("shows the cast's voice sample when the form has none, as the cast's", () => {
    draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} cast={{ asset: "zz-test-voice", from: "Marl" }} />);
    expect(screen.queryByText(/Choose an audio file, or drop one here/)).toBeNull();
    expect(screen.getByText(/from the cast/).textContent).toContain("Marl's voice");
    expect(screen.getByRole("button", { name: "Use another" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("shows the form's own sample instead when it has one", () => {
    draw(<SoundField label="Voice sample" optional value="zz-test-mine" onChange={() => {}} cast={{ asset: "zz-test-voice", from: "Marl" }} />);
    expect(screen.queryByText(/from the cast/)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("stays empty with no cast voice and no sample", () => {
    draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    expect(screen.getByText(/Choose an audio file, or drop one here/)).toBeTruthy();
  });
});
