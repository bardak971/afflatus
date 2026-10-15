import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { Progress, ProgressRing } from "../../src/progress/Progress";
import { ProgressPicker } from "../../src/progress/ProgressPicker";
import { glideTo, ticksOf } from "../../src/progress/style";
import { useThemeChoice } from "../../src/theme/store";
import { draw } from "./render";

/** The system asking for less motion, or not: matchMedia as a browser answers it. */
function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}
const bar = () => screen.getByRole("progressbar");
const fill = () => bar().querySelector<HTMLElement>("[data-fill]")!;
const ticks = () => [...bar().children] as HTMLElement[];

afterEach(() => vi.restoreAllMocks());

describe("a progress bar in each style", () => {
  it("Same look: the fill slid to the value by transform, with a short ease, and no width", () => {
    reducedMotion(false);
    const { rerender } = draw(<Progress styleAs="same" value={0.2} />);
    rerender(<Progress styleAs="same" value={0.35} />);
    expect(bar().dataset.progress).toBe("same");
    expect(fill().style.transform).toBe("translateX(-65%)");
    expect(fill().style.transition).toBe("transform 300ms ease-out");
    expect(fill().style.width).toBe("");
  });

  it("Glide: at the render's pace, towards the next step it expects and never past it", () => {
    reducedMotion(false);
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const { rerender } = draw(<Progress styleAs="glide" value={0.1} />);
    now.mockReturnValue(1500);
    rerender(<Progress styleAs="glide" value={0.2} />);
    // the first step came 500 ms after the one before: one more step of 0.1 in 500 ms, linearly
    expect(fill().style.transform).toBe("translateX(-70%)");
    expect(fill().style.transition).toBe("transform 500ms linear");
    now.mockReturnValue(2000);
    rerender(<Progress styleAs="glide" value={0.95} />);
    // the next step expected is past the end: it aims at the end
    expect(fill().style.transform).toBe("translateX(0%)");
  });

  it("Steps: one tick per step, grouped past 40, nothing moving", () => {
    reducedMotion(false);
    const { rerender } = draw(<Progress styleAs="steps" value={7 / 20} steps={20} />);
    expect(ticks()).toHaveLength(20);
    expect(ticks().filter((t) => t.dataset.lit)).toHaveLength(7);
    expect(bar().querySelector("[data-fill]")).toBeNull();
    rerender(<Progress styleAs="steps" value={10 / 50} steps={50} />);
    expect(ticks()).toHaveLength(25);
    expect(ticks().filter((t) => t.dataset.lit)).toHaveLength(5);
    expect(ticksOf(undefined)).toBe(20);
  });

  it("Alive: Same look with a light sweeping along the bar while it works, none once done", () => {
    reducedMotion(false);
    const { rerender } = draw(<Progress styleAs="alive" value={0.4} />);
    expect(bar().querySelector("[class*=progress-sweep]")).not.toBeNull();
    expect(fill().style.transition).toBe("transform 300ms ease-out");
    rerender(<Progress styleAs="alive" value={1} />);
    expect(bar().querySelector("[class*=progress-sweep]")).toBeNull();
  });

  it("loading the model, before any step: the whole bar pulsing, or in Steps a first tick in grey", () => {
    reducedMotion(false);
    const { rerender } = draw(<Progress styleAs="glide" value={0} loading />);
    expect(bar().querySelector(".animate-pulse")).not.toBeNull();
    expect(bar().querySelector("[data-fill]")).toBeNull();
    rerender(<Progress styleAs="steps" value={0} steps={20} loading />);
    expect(ticks()[0]!.className).toContain("bg-ink-3");
    expect(ticks().filter((t) => t.dataset.lit)).toHaveLength(0);
  });

  it("a gauge (a GPU's load) never glides, ticks nor sweeps: it jumps to its figure", () => {
    reducedMotion(false);
    for (const style of ["glide", "steps", "alive"] as const) {
      const { unmount } = draw(<Progress styleAs={style} meter value={0.5} />);
      expect(bar().dataset.progress).toBe("meter");
      expect(fill().style.transition).toBe("none");
      expect(bar().querySelector("[class*=progress-sweep]")).toBeNull();
      unmount();
    }
  });
});

describe("the Queue's ring", () => {
  it("moves by turning two half rings (no SVG dash), and in Steps is a dot per step", () => {
    reducedMotion(false);
    const { container, rerender } = draw(<ProgressRing styleAs="same" value={0.75} steps={20} />);
    const turned = [...container.querySelectorAll<HTMLElement>("[style*=rotate]")].map((e) => e.style.transform);
    expect(turned).toEqual(["rotate(180deg)", "rotate(90deg)", "rotate(270deg)"]);
    expect(container.querySelector("[stroke-dashoffset]")).toBeNull();
    rerender(<ProgressRing styleAs="steps" value={0.5} steps={8} />);
    const dots = [...container.querySelectorAll("circle")];
    expect(dots).toHaveLength(8);
    expect(dots.filter((d) => d.getAttribute("fill") === "var(--color-accent)")).toHaveLength(4);
  });

  it("Alive: a dot circles it", () => {
    reducedMotion(false);
    const { container } = draw(<ProgressRing styleAs="alive" value={0.3} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("Settings › Interface › Progress", () => {
  it("is Glide until another is picked, kept in this browser with the theme, and every bar follows it", async () => {
    reducedMotion(false);
    const { user } = draw(<><ProgressPicker /><div data-testid="bar"><Progress value={0.5} steps={10} /></div></>);
    expect(screen.getByRole("button", { name: "Glide" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("bar").querySelector("[role=progressbar]")!.getAttribute("data-progress")).toBe("glide");
    // each style shown moving: a ring, a status line and a bar of its own
    expect(screen.getByRole("button", { name: "Same look" }).querySelectorAll("[role=progressbar]")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Steps" }));
    expect(useThemeChoice.getState().progress).toBe("steps");
    expect(JSON.parse(localStorage.getItem("afflatus.theme")!).state.progress).toBe("steps");
    expect(screen.getByTestId("bar").querySelector("[role=progressbar]")!.getAttribute("data-progress")).toBe("steps");
    expect(screen.getByRole("button", { name: "Steps" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("with reduced motion asked by the system, Glide and Alive are drawn as Steps, and Same look has no ease", () => {
    reducedMotion(true);
    act(() => useThemeChoice.getState().set({ progress: "alive" }));
    const { rerender } = draw(<><ProgressPicker /><Progress value={0.5} steps={10} /></>);
    expect(screen.getAllByRole("progressbar").at(-1)!.dataset.progress).toBe("steps");
    expect(screen.getByText(/drawn as Steps/)).toBeTruthy();
    act(() => useThemeChoice.getState().set({ progress: "same" }));
    rerender(<Progress value={0.6} />);
    expect(fill().style.transition).toBe("none");
  });
});

describe("the glide's aim", () => {
  it("draws a first value and a value that went back at once, and a step longer than two minutes waits at its step", () => {
    const first = glideTo(null, 0.1, 0);
    expect(first).toMatchObject({ aim: 0.1, ms: 0 });
    const back = glideTo(glideTo(first, 0.5, 400), 0.2, 800);
    expect(back).toMatchObject({ aim: 0.2, ms: 0 });
    const slow = glideTo(glideTo(glideTo(null, 0.1, 0), 0.2, 200_000), 0.3, 400_000);
    expect(slow).toMatchObject({ aim: 0.3, ms: 0 });
  });
});
