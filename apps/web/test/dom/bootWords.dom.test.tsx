import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useSecond } from "../../src/hooks";
import { BootNote } from "../../src/machineBits";
import { draw } from "./render";

afterEach(() => vi.useRealTimers());

/** A screen that says the time the shared clock is at, as the pill and a pod's card each read it. */
function Said({ id }: { id: string }) {
  return <span data-testid={id}>{useSecond()}</span>;
}

describe("a booting pod's words, the same in every place", () => {
  it("reads one clock to the second: two screens never a second apart", () => {
    vi.useFakeTimers({ now: 1_800_000_000_400 });
    draw(<><Said id="pill" /><Said id="card" /></>);
    for (let i = 0; i < 5; i++) {
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.getByTestId("pill").textContent).toBe(screen.getByTestId("card").textContent);
    }
    expect(Number(screen.getByTestId("pill").textContent) % 1000).toBe(0);
  });

  it("says its second line with its boot log's link, the plain words in its ?", () => {
    draw(<BootNote machine="rp-1" boot={{ phase: "pulling", step: null, failed: false, from: 0 }} />);
    expect(screen.getByText(/^boot · auto-terminate at 20m if ComfyUI doesn't answer/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "boot log" }).getAttribute("href")).toBe("/queue?view=log&machine=rp-1");
    expect(screen.getByRole("button", { name: /pulls its image onto the host/ })).toBeTruthy();
  });
});
