import { describe, expect, it } from "vitest";
import { promptParts, WEIGHT_NUMBER, WEIGHT_SYNTAX } from "../src";

// card #311: four readers of a weight's number that parted on ".5", a sign and an exponent, now one pattern (ComfyUI's float())
describe("a weight's number", () => {
  const whole = new RegExp(`^${WEIGHT_NUMBER}$`);

  it("is what Python's float() reads, and nothing else", () => {
    for (const n of ["1", "1.2", "0.85", ".5", "1.", "-1", "+0.5", "-.25", "1e-1", "2E3"]) expect(whole.test(n), n).toBe(true);
    for (const n of ["", ".", "-", "1.2.3", "1e", "e5", "1,5", "0x1", "a1"]) expect(whole.test(n), n).toBe(false);
  });

  it("is a weight to ComfyUI's tokens, a colon that is not one staying in the text", () => {
    expect(promptParts("(red dress:1.2), (sky:.5), (sea:-1), (16:9 frame)")).toEqual(["red dress", ", ", "sky", ", ", "sea", ", ", "16:9 frame"]);
  });

  it("is spotted by the linter with a minus or no leading digit, as it always was with digits", () => {
    for (const t of ["a (red dress:1.2) b", "(red dress: 1.2)", "(sky:.5)", "(sea:-1)", "(sea:1e-1)"]) expect(WEIGHT_SYNTAX.test(t), t).toBe(true);
    for (const t of ["(16:9 frame)", "(red dress)", "red dress:1.2", "(time: noon)"]) expect(WEIGHT_SYNTAX.test(t), t).toBe(false);
  });
});
