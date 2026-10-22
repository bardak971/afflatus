import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Dialog, DialogFoot, DialogHead } from "../../src/Dialog";
import { markPlace } from "../../src/motion";
import { Chip, CloseButton, Empty, Help, IconButton, PageHeader, SearchField, SectionTitle, Spinner } from "../../src/ui";
import { draw } from "./render";

// the kit's pieces from review 4 (section 4.2): one of each, so that a screen does not draw its own
describe("the kit's icon buttons", () => {
  it("names an icon button by its label, for a screen reader and the app's tip, in one of three sizes", async () => {
    const pressed = vi.fn();
    const { user } = draw(<><IconButton label="Zoom in" keys="+" onClick={pressed}><span>+</span></IconButton><IconButton label="Loop" size={28} pressed><span>L</span></IconButton></>);
    const zoom = screen.getByRole("button", { name: "Zoom in" });
    expect(zoom.dataset.tip).toBe("Zoom in");
    expect(zoom.dataset.tipKeys).toBe("+");
    expect(zoom.className).toContain("size-8");
    expect(zoom.className).toContain("rounded-control");
    await user.click(zoom);
    expect(pressed).toHaveBeenCalledOnce();
    const loop = screen.getByRole("button", { name: "Loop" });
    expect(loop.getAttribute("aria-pressed")).toBe("true");
    expect(loop.className).toContain("size-7");
  });
  it("closes through the one close button, Close by default", async () => {
    const closed = vi.fn();
    const { user } = draw(<CloseButton keys="Esc" onClose={closed} />);
    const x = screen.getByRole("button", { name: "Close" });
    expect(x.dataset.tipKeys).toBe("Esc");
    await user.click(x);
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe("the kit's search field", () => {
  function Typed() {
    const [q, setQ] = useState("");
    return <><SearchField label="Search drafts" value={q} onChange={setQ} /><span data-testid="q">{q}</span></>;
  }
  it("hands what is typed back as text, and marks its focus on the box around it (finding 21)", async () => {
    const { user } = draw(<Typed />);
    const field = screen.getByRole("textbox", { name: "Search drafts" });
    expect(field.getAttribute("placeholder")).toBe("Search drafts");
    await user.type(field, "zz-test");
    expect(screen.getByTestId("q").textContent).toBe("zz-test");
    // the input draws no outline of its own (styles.css): the ring is the box's, while anything in it has the focus
    const box = field.closest("label")!;
    expect(box.className).toContain("focus-within:border-accent");
    expect(box.className).toContain("h-8");
  });
  it("heads a panel without a box, its focus an underline", () => {
    draw(<SearchField look="head" label="Find a model" value="" onChange={() => {}} className="h-11 px-3" />);
    const box = screen.getByRole("textbox", { name: "Find a model" }).closest("label")!;
    expect(box.className).toContain("focus-within:shadow-[inset_0_-2px_0_var(--color-accent)]");
    expect(box.className).not.toContain("rounded-control");
  });
});

describe("the kit's marks and states", () => {
  it("draws a chip at 18 px and in the attention amber", () => {
    draw(<Chip size="xs" tone="attention">stale join</Chip>);
    const chip = screen.getByText("stale join");
    expect(chip.className).toContain("h-4.5");
    expect(chip.className).toContain("bg-attention-wash");
  });
  it("keeps the ? neutral at rest, in the accent only on hover or focus, with a 24 px target", () => {
    draw(<Help text="What CFG does" />);
    const mark = screen.getByRole("button", { name: "What CFG does" });
    expect(mark.className).toContain("size-6");
    const glyph = mark.firstElementChild!;
    expect(glyph.className).toContain("text-ink-3");
    expect(glyph.className).not.toMatch(/(^| )text-accent( |$)/);
    expect(glyph.className).toContain("group-hover/help:text-accent");
  });
  it("gives an empty state a way to fill it", () => {
    draw(<Empty title="Nothing here yet" action={<button type="button">Open the form</button>}>Drop pictures or videos here</Empty>);
    expect(screen.getByRole("button", { name: "Open the form" })).toBeTruthy();
  });
  it("heads a page with its title, what follows it and its actions", () => {
    draw(<PageHeader title="Queue" after={<span>tabs</span>} actions={<button type="button">Pause all</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Queue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause all" })).toBeTruthy();
  });
  it("titles a section and a group in two looks", () => {
    draw(<><SectionTitle>Output</SectionTitle><SectionTitle level="group">After sampling</SectionTitle></>);
    expect(screen.getByText("Output").className).toContain("uppercase");
    expect(screen.getByText("After sampling").className).not.toContain("uppercase");
  });
  it("stands its spinner still under reduce motion", () => {
    const { container } = draw(<Spinner size={14} />);
    const ring = container.querySelector("span")!;
    expect(ring.className).toContain("motion-reduce:animate-none");
    expect(ring.style.width).toBe("14px");
  });
});

describe("a place marked after a jump", () => {
  it("holds a still ring where motion is not allowed, and takes it away after the time a fading one lasts", () => {
    vi.useFakeTimers();
    const asked = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    try {
      const row = document.createElement("div");
      row.animate = vi.fn() as unknown as HTMLElement["animate"];
      markPlace(row, 1400);
      // "reduce motion": nothing animates, the ring stands
      expect(row.animate).not.toHaveBeenCalled();
      expect(row.style.boxShadow).toContain("var(--color-accent)");
      vi.advanceTimersByTime(1400);
      expect(row.style.boxShadow).toBe("");
      // motion allowed: the ring fades through the Web Animations API, nothing left on the element
      asked.mockReturnValue({ matches: true } as MediaQueryList);
      markPlace(row, 1400);
      expect(row.animate).toHaveBeenCalledOnce();
      expect(row.style.boxShadow).toBe("");
    } finally {
      asked.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("a dialog's way out", () => {
  it("is the head's × alone: a foot with nothing in it is not drawn (P11)", () => {
    draw(
      <Dialog label="zz-test dialog" onClose={() => {}}>
        <DialogHead title="zz-test dialog" onClose={() => {}} />
        <DialogFoot>{false}{null}</DialogFoot>
      </Dialog>,
    );
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(document.querySelector(".border-t.border-line")).toBeNull();
  });
});
