import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { RunningJob } from "../../src/api";
import { StripModel } from "../../src/ModelLoad";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The status bar's model chip while a render changes the model: it said "Loading <the previous model>…", the machine's note
 * being the model before it until ComfyUI takes the prompt.
 */

const running = (over: Partial<RunningJob>): Partial<RunningJob> => ({ id: "j1", kind: "render", status: "running", recipe: "zz-test.picture", progress: 0, eta: 0, step: 0, steps: 20, previewSeq: 0, ...over });

function serve(run: Partial<RunningJob> | null) {
  fakeApi.on("GET /queue", { online: true, paused: false, model: "zz-test-sdxl", modelFamily: "zz-sdxl", running: run, waiting: [], later: [], recent: [], machines: [] });
  fakeApi.on("GET /recipes", { families: [{ id: "zz-sdxl", name: "SDXL" }, { id: "zz-krea", name: "Krea 2" }], recipes: [] });
}

const text = () => screen.getAllByText(/^(Loading|zz-test.*)$/)[0]!.closest("[data-tip]")!.textContent;

describe("the strip's model chip while a render loads another model", () => {
  it("names the model the render brings in, with its family, from its files going up to its load", async () => {
    for (const phase of ["waiting", "loading"]) {
      serve(running({ phase, loads: { model: "zz-test-krea", family: "zz-krea" } }));
      const { unmount } = draw(<StripModel />);
      await waitFor(() => expect(screen.getByText("Loading")).toBeTruthy());
      expect(text()).toBe("LoadingKrea 2·zz-test-krea…");
      unmount();
    }
  });

  it("names it as held once it is in, whatever the machine's note still says", async () => {
    serve(running({ phase: "sampling", step: 4, loads: { model: "zz-test-krea", family: "zz-krea" } }));
    draw(<StripModel />);
    await waitFor(() => expect(screen.getByText("zz-test-krea")).toBeTruthy());
    expect(text()).toBe("Krea 2·zz-test-krea");
    expect(screen.queryByText("zz-test-sdxl")).toBeNull();
  });

  it("names the model held, with its family, for a render that brings none in", async () => {
    serve(running({ phase: "sampling", step: 4, loads: null }));
    draw(<StripModel />);
    await waitFor(() => expect(screen.getByText("zz-test-sdxl")).toBeTruthy());
    expect(text()).toBe("SDXL·zz-test-sdxl");
  });
});
