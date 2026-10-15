import { describe, expect, it } from "vitest";
import { backspaceAt, codeOf, emptyCode, typedInto } from "../src/access/codeBoxes";

/** The reset code's six boxes (access/SignIn.tsx): a digit a box, a paste fills them, Backspace goes back. */
describe("the code's boxes", () => {
  it("take a digit and move on, and only digits", () => {
    let s = typedInto(emptyCode(), 0, "4");
    expect(s).toEqual({ digits: ["4", "", "", "", "", ""], focus: 1 });
    s = typedInto(s.digits, 1, "x");
    expect(s.digits[1]).toBe("");
    expect(s.focus).toBe(1);
    // a box that held a digit takes the one typed after it
    s = typedInto(s.digits, 0, "48");
    expect(s).toEqual({ digits: ["8", "", "", "", "", ""], focus: 1 });
  });

  it("spread a paste from the box it lands in, and a whole code from the first", () => {
    expect(typedInto(emptyCode(), 2, "91")).toEqual({ digits: ["", "", "9", "1", "", ""], focus: 4 });
    expect(typedInto(emptyCode(), 3, "481 205")).toEqual({ digits: ["4", "8", "1", "2", "0", "5"], focus: 5 });
    expect(typedInto(emptyCode(), 4, "1234")).toEqual({ digits: ["", "", "", "", "1", "2"], focus: 5 });
  });

  it("go back with Backspace: a digit goes, an empty box takes the one before", () => {
    const full = ["4", "8", "1", "", "", ""];
    expect(backspaceAt(full, 2)).toEqual({ digits: ["4", "8", "", "", "", ""], focus: 2 });
    expect(backspaceAt(full, 3)).toEqual({ digits: ["4", "8", "", "", "", ""], focus: 2 });
    expect(backspaceAt(emptyCode(), 0)).toEqual({ digits: emptyCode(), focus: 0 });
  });

  it("make a code only with every digit", () => {
    expect(codeOf(["4", "8", "1", "2", "0", "5"])).toBe("481205");
    expect(codeOf(["4", "8", "1", "2", "0", ""])).toBeNull();
  });
});
