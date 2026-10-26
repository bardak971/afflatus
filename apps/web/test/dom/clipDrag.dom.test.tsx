import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import type { Clip } from "../../src/api";
import { PAD, type Slot } from "../../src/timeline/model";
import { useClipDrag } from "../../src/timeline/track/useClipDrag";
import { draw } from "./render";

/** Three clips 100 px wide, edge to edge from the track's start; the pointer's x is the track's own. */
const slots: Slot[] = ["a", "b", "c"].map((id, index) => ({ clip: { id } as unknown as Clip, index, startMs: index * 1000, lengthMs: 1000, left: PAD + index * 100, width: 100, planned: false }));

/** The track's clips as the drag sees them: a wrapper each, the clip inside taking the pointer; its clicks counted. */
function rig(onMove = vi.fn()) {
  const clicks: string[] = [];
  function Lane() {
    const scroller = useRef<HTMLDivElement>(null);
    const d = useClipDrag({ slots, pps: 100, xOf: (x) => x, scroller, onMove });
    return (
      <div ref={scroller}>
        {slots.map((s) => (
          <div key={s.clip.id} ref={d.mount(s.clip.id)}>
            <div
              role="button"
              aria-label={`clip ${s.clip.id}`}
              data-lift={d.shown?.clip === s.clip.id ? (d.shown.holding ? "held" : "landing") : ""}
              onPointerDown={(e) => d.down(e, s)}
              onPointerMove={d.move}
              onPointerUp={d.up}
              onPointerCancel={d.cancel}
              onClick={() => !d.dragged() && clicks.push(s.clip.id)}
            />
          </div>
        ))}
        <span data-testid="order">{d.shown?.order.join(",") ?? ""}</span>
      </div>
    );
  }
  draw(<Lane />);
  return { onMove, clicks };
}

describe("a clip moved along the track by the pointer (review 4, P7)", () => {
  it("follows the pointer, takes its place past the next clip's middle and is moved there once on release", async () => {
    const { onMove, clicks } = rig();
    const a = screen.getByRole("button", { name: "clip a" });
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: PAD + 50 });
    fireEvent.pointerMove(a, { pointerId: 1, clientX: PAD + 80 });
    expect(a.dataset.lift).toBe("held");
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
    // its middle past b's: b slides before it, before any release
    fireEvent.pointerMove(a, { pointerId: 1, clientX: PAD + 160 });
    expect(screen.getByTestId("order").textContent).toBe("b,a,c");
    // the clip's wrapper moved with the pointer, 1:1 from where it was taken
    expect(a.parentElement!.style.transform).toBe("translateX(110px)");
    fireEvent.pointerUp(a, { pointerId: 1, clientX: PAD + 160 });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("a", "b");
    expect(a.dataset.lift).toBe("landing");
    // the click the release makes is not a click on the clip; a later one (a key, a script) is
    fireEvent.click(a);
    expect(clicks).toEqual([]);
    await new Promise((done) => setTimeout(done, 0));
    fireEvent.click(a);
    expect(clicks).toEqual(["a"]);
  });

  it("puts it back on Esc during the drag, with nothing moved", () => {
    const { onMove, clicks } = rig();
    const b = screen.getByRole("button", { name: "clip b" });
    fireEvent.pointerDown(b, { button: 0, pointerId: 2, clientX: PAD + 150 });
    fireEvent.pointerMove(b, { pointerId: 2, clientX: PAD + 40 });
    expect(screen.getByTestId("order").textContent).toBe("b,a,c");
    const esc = fireEvent.keyDown(window, { key: "Escape" });
    // the editor's own Esc does not hear it
    expect(esc).toBe(false);
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
    fireEvent.pointerMove(b, { pointerId: 2, clientX: PAD + 10 });
    fireEvent.pointerUp(b, { pointerId: 2, clientX: PAD + 10 });
    fireEvent.click(b);
    expect(onMove).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("leaves a press without a move a click, and a drag back to its own place no move", () => {
    const { onMove, clicks } = rig();
    const c = screen.getByRole("button", { name: "clip c" });
    fireEvent.pointerDown(c, { button: 0, pointerId: 3, clientX: PAD + 250 });
    fireEvent.pointerMove(c, { pointerId: 3, clientX: PAD + 252 });
    fireEvent.pointerUp(c, { pointerId: 3, clientX: PAD + 252 });
    fireEvent.click(c);
    expect(clicks).toEqual(["c"]);
    expect(c.dataset.lift).toBe("");
    fireEvent.pointerDown(c, { button: 0, pointerId: 4, clientX: PAD + 250 });
    fireEvent.pointerMove(c, { pointerId: 4, clientX: PAD + 230 });
    fireEvent.pointerUp(c, { pointerId: 4, clientX: PAD + 230 });
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("the key listener of a drag (B27)", () => {
  it("is the one function added and removed: none is left on the window after the drag", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    try {
      rig();
      const a = screen.getByRole("button", { name: "clip a" });
      fireEvent.pointerDown(a, { button: 0, pointerId: 3, clientX: PAD + 50 });
      // drawn again while held: each render made the key listener anew
      fireEvent.pointerMove(a, { pointerId: 3, clientX: PAD + 80 });
      fireEvent.pointerMove(a, { pointerId: 3, clientX: PAD + 160 });
      fireEvent.pointerUp(a, { pointerId: 3, clientX: PAD + 160 });
      const keys = (spy: typeof added) => spy.mock.calls.filter(([type, , capture]) => type === "keydown" && capture === true).map(([, fn]) => fn);
      expect(keys(added)).toHaveLength(1);
      expect(keys(removed)).toContain(keys(added)[0]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
