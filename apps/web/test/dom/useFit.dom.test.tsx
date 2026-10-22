import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useFit } from "../../src/useFit";
import { draw } from "./render";

// the media shelf's bar is drawn only while the shelf is open: the fit has to watch the bar that comes with the opening
describe("a bar that folds to fit", () => {
  const watched: Element[] = [];
  afterEach(() => {
    watched.length = 0;
    vi.unstubAllGlobals();
  });

  function Shelf() {
    const [open, setOpen] = useState(false);
    const bar = useRef<HTMLDivElement>(null);
    useFit(bar, 3, open ? "open" : "");
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Show the media</button>
        {open && <div ref={bar} data-testid="bar" />}
      </>
    );
  }

  it("watches the bar drawn after it was first called, once its key says so", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(el: Element) {
          watched.push(el);
        }
        disconnect() {}
      },
    );
    const { user } = draw(<Shelf />);
    // folded: there is no bar yet, nothing is watched
    expect(watched).toHaveLength(0);
    await act(() => user.click(screen.getByRole("button", { name: "Show the media" })));
    expect(watched).toContain(screen.getByTestId("bar"));
  });
});
