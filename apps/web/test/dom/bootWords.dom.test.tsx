import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useSecond } from "../../src/hooks";
import type { MachineState } from "../../src/api";
import { BootNote, Dot } from "../../src/machineBits";
import { podsAdded } from "../../src/machines";
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

  it("gives a booting pod the starting look, never the warning a failed start or one away has", () => {
    const pod = (boot: object | null) => ({
      id: "pod", name: "A40", url: "https://x", takes: "all", paused: false, online: false, locked: false, model: null, pace: null, running: null,
      rented: { status: "RUNNING", since: null, booting: true, answers: null, stopping: false, files: [], boot },
    }) as unknown as MachineState;
    const booting = draw(<Dot m={pod({ phase: "pulling", step: null, failed: false, from: 0 })} />).container.querySelector("span")!;
    expect(booting.dataset.state).toBe("starting");
    expect(booting.className).not.toContain("warn");
    const failed = draw(<Dot m={pod({ phase: "step", step: "checking the GPU (exit 1)", failed: true, from: 0 })} />).container.querySelector("span")!;
    expect(failed.dataset.state).toBe("failed");
    expect(failed.className).toContain("bg-warn");
  });

  it("lists a pod as its machine as soon as the settings have it, whatever RunPod's last list said", () => {
    const pods = [{ id: "p1", added: null }, { id: "p2", added: null }, { id: "p3", added: "m3" }];
    expect(podsAdded(pods, [{ id: "rp-1", rented: { pod: "p1" } }, { id: "home", rented: null }]).map((p) => p.added)).toEqual(["rp-1", null, "m3"]);
  });
});
