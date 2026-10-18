import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { RecipeInfo } from "../../src/api";
import { ShareFoot, type ClipSource } from "../../src/timeline/inspector/clipSource";
import { draw } from "./render";

const recipe = { id: "zz-test.swap", inputs: [{ id: "swapStrength", type: "number", label: "Swap LoRA strength" }] } as unknown as RecipeInfo;

function foot(over: Partial<ClipSource> = {}) {
  const asked: string[] = [];
  const s: ClipSource = {
    source: { pick: null } as never, count: 7, first: false, apart: [], takesPick: true, picking: false,
    onPicking: () => {}, onClearPick: () => {}, kept: false, windows: { leastMs: 3800, mostMs: 4900 }, onCut: () => {}, cutting: false,
    mask: { status: "none", shown: false }, onShowMask: () => {}, onMaskShown: () => {},
    onKept: (on) => asked.push(on ? "this clip" : "all"), onInLine: () => asked.push("in line"), onToAll: () => asked.push("to all"),
    ...over,
  };
  draw(<ShareFoot s={s} recipe={recipe} />);
  return asked;
}

describe("a clip made from the source, at its panel's foot (the owner, 2026-10-18)", () => {
  it("sends a change to every clip of the source unless kept to this one", () => {
    const asked = foot();
    expect(screen.getByRole("radio", { name: "All 7 clips" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "This clip" }));
    expect(asked).toEqual(["this clip"]);
    // nothing kept apart: nothing said of it
    expect(screen.queryByText(/Set apart/)).toBeNull();
  });

  it("says what a clip set apart keeps its own, by the settings' names, with the way back", () => {
    const asked = foot({ apart: ["swapStrength"] });
    expect(screen.getByText(/Set apart from the other 6 clips/)).toBeTruthy();
    expect(screen.getByText("Swap LoRA strength")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bring in line" }));
    fireEvent.click(screen.getByRole("button", { name: "Give it to all 7" }));
    expect(asked).toEqual(["in line", "to all"]);
  });
});
