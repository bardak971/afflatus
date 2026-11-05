import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { Select } from "../../src/Select";
import { draw } from "./render";

/**
 * The Grid's axis pickers, live (2026-11-04): picked in X, then one click on Y did nothing, a second opened it. The form was
 * still gliding from the wheel that brought Y into reach, and every Select closed on any scroll outside its list: the list
 * opened and the scroll's next event closed it at once. A scroll already going as a list opens now moves it along with its
 * button; a scroll begun once it is open still closes it, and a press outside still only closes it.
 *
 * Card #316 (2026-11-05): the same first click failed 2 times in 5 with the form standing still. Values typed in X, then a
 * click on Y: the form glided on its own to its bottom (a part's height changing as X's values were taken), no wheel or key
 * in it, and that scroll closed the list. A scroll the page does by itself now moves the list along; only one the user asks
 * for (a wheel, a finger, a key, a press elsewhere) closes it.
 */

const OPTIONS = [{ value: "", label: "None" }, { value: "cfg", label: "CFG scale" }, { value: "steps", label: "Steps" }];

function Two() {
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  return (
    <div data-testid="form" style={{ overflowY: "auto" }}>
      <Select label="X axis" value={x} options={OPTIONS} onChange={setX} />
      <input aria-label="X values" />
      <Select label="Y axis" value={y} options={OPTIONS} onChange={setY} />
    </div>
  );
}

// where the form has scrolled the buttons to: happy-dom lays nothing out, so their place is said here
let shift = 0;
const placed = () => {
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLButtonElement) {
    const top = (this.getAttribute("aria-label")?.startsWith("Y") ? 200 : 100) - shift;
    return { top, bottom: top + 32, left: 20, right: 220, width: 200, height: 32, x: 20, y: top, toJSON: () => ({}) } as DOMRect;
  });
};
/** The form scrolls by `by` pixels: one scroll event, as the browser sends it. */
const scroll = (by: number) => {
  shift += by;
  fireEvent.scroll(screen.getByTestId("form"));
};
/** Longer than the gap between two events of one scroll (scrollAway.ts): what comes after is a scroll of its own. */
const later = () => act(() => new Promise((r) => setTimeout(r, 200)));

afterEach(() => {
  shift = 0;
  vi.restoreAllMocks();
});

describe("a Select's list", () => {
  it("opens on one click after a pick in another Select and values typed beside it", async () => {
    placed();
    const { user } = draw(<Two />);
    await user.click(screen.getByRole("button", { name: "X axis: None" }));
    await user.click(screen.getByRole("option", { name: /CFG scale/ }));
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(screen.getByLabelText("X values"), "3, 5, 7");
    await user.click(screen.getByRole("button", { name: "Y axis: None" }));
    expect(screen.getByRole("listbox", { name: "Y axis" })).toBeTruthy();
  });

  it("stays open through the tail of a scroll still going as it was clicked, and follows its button", async () => {
    placed();
    const { user } = draw(<Two />);
    // the wheel's glide: scroll events a few milliseconds apart, the click among them
    for (let i = 0; i < 3; i++) scroll(10);
    await user.click(screen.getByRole("button", { name: "Y axis: None" }));
    for (let i = 0; i < 3; i++) act(() => scroll(10));
    expect(screen.getByRole("listbox", { name: "Y axis" })).toBeTruthy();
    // under the button where it is now: 200 - 60 scrolled + 32 tall + 4 apart
    expect(screen.getByRole("listbox").closest<HTMLElement>("[data-floating]")!.style.top).toBe("176px");
  });

  it("closes on a scroll begun once it is open, not on one that leaves its button in place", async () => {
    placed();
    const { user } = draw(<Two />);
    await later();
    await user.click(screen.getByRole("button", { name: "Y axis: None" }));
    // another box scrolled, or the browser kept the view in place: the button did not move
    await later();
    act(() => scroll(0));
    expect(screen.getByRole("listbox", { name: "Y axis" })).toBeTruthy();
    await later();
    act(() => {
      fireEvent.wheel(screen.getByTestId("form"), { deltaY: 40 });
      scroll(40);
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open through a scroll the page does by itself once it is open, and follows its button", async () => {
    placed();
    const { user } = draw(<Two />);
    await user.type(screen.getByLabelText("X values"), "3, 5, 7");
    await later();
    await user.click(screen.getByRole("button", { name: "Y axis: None" }));
    // the form glides to its bottom on its own, no wheel, finger or key: its events come one after another
    await later();
    for (let i = 0; i < 4; i++) act(() => scroll(15));
    expect(screen.getByRole("listbox", { name: "Y axis" })).toBeTruthy();
    // under the button where it is now: 200 - 60 scrolled + 32 tall + 4 apart
    expect(screen.getByRole("listbox").closest<HTMLElement>("[data-floating]")!.style.top).toBe("176px");
    // and the user's own scroll after it still closes it
    await later();
    act(() => {
      fireEvent.keyDown(screen.getByTestId("form"), { key: "PageDown" });
      scroll(40);
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on a press outside it, and that same click opens the Select pressed", async () => {
    placed();
    const { user } = draw(<Two />);
    await user.click(screen.getByRole("button", { name: "X axis: None" }));
    // the press on Y while X is open closes X; its click then opens Y, as before
    await user.click(screen.getByRole("button", { name: "Y axis: None" }));
    expect(screen.getAllByRole("listbox").map((l) => l.getAttribute("aria-label"))).toEqual(["Y axis"]);
    expect(screen.getByRole("button", { name: "X axis: None" }).getAttribute("aria-expanded")).toBe("false");
  });
});
