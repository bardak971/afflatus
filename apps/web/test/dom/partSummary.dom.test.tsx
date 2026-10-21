import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Part, useParts } from "../../src/recipeForm/Part";
import { draw } from "./render";

describe("a part's one-line summary", () => {
  // under "reduce motion" the fold changes at once: the test looks at what is drawn, not at the fold's motion
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query } as MediaQueryList));
  });
  afterEach(() => vi.restoreAllMocks());
  it("shows while the part is folded, and goes when it is opened: the settings say it then", async () => {
    useParts.setState({ open: { "zz-test-part": false } });
    const { user } = draw(<Part id="zz-test-part" title="Sampling" summary="34 steps · CFG 5"><p>Steps row</p></Part>);
    expect(screen.getByText("34 steps · CFG 5")).toBeTruthy();
    expect(screen.queryByText("Steps row")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sampling: unfold" }));
    expect(screen.getByText("Steps row")).toBeTruthy();
    expect(screen.queryByText("34 steps · CFG 5")).toBeNull();
  });
});
