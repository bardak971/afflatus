import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FaceLine } from "../../src/timeline/inspector/faceLine";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Card #223: a timeline clip with a person's picture says at the top of its references what it does with it, why in its
 * "?"; a clip whose picture changed names the clips after it still on the old one and gives them its own in one click.
 */
describe("what a clip does with its person's picture", () => {
  it("says a continuation with the same pictures gets its face from Face refine, and why", () => {
    draw(<FaceLine timeline="t1" clip="c2" route={{ route: "carried", before: 1 }} />);
    expect(screen.getByText(/On this continuation the face comes from Face refine towards the person's picture, carried on from clip 1\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Person picture on continuations: Sampled with a person's picture, a continuation takes on the picture's colour and light/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this one on them too" })).toBeNull();
  });

  it("says a first clip is sampled with it, and nothing for a clip without one", () => {
    const { container } = draw(<FaceLine timeline="t1" clip="c1" route={{ route: "sampled", why: "first" }} />);
    expect(screen.getByText(/Sampled with the person's picture: the clips that carry on from this one keep its face by Face refine\./)).toBeTruthy();
    expect(container.querySelector("[data-face-route]")?.getAttribute("data-face-route")).toBe("sampled");
    const none = draw(<FaceLine timeline="t1" clip="c9" route={undefined} />);
    expect(none.container.querySelector("[data-face-route]")).toBeNull();
  });

  it("names the clips after a changed picture still on the old one, and gives them this one", async () => {
    fakeApi.on("POST /clips/:id/face/spread", { from: 4, to: 5, said: "2 clips (4–5) take this clip's person picture." });
    draw(<FaceLine timeline="t1" clip="c3" route={{ route: "sampled", why: "changed", before: 2, keepOld: { from: 4, to: 5 } }} />);
    expect(screen.getByText(/This clip starts a new look: sampled with the person's picture, which differs from clip 2's\./)).toBeTruthy();
    expect(screen.getByText(/Clips 4–5 still have clip 2's picture: they would be sampled with the old face again\./)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use this one on them too" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/clips/c3/face/spread")).toHaveLength(1));
  });
});
