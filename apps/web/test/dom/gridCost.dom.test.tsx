import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { GridCost } from "../../src/grid/GridCard";
import type { GridPlan } from "../../src/grid/gridPlan";
import { draw } from "./render";

/**
 * The grid card's money line (card #328): the plain forecast, and what it may cost with an unsure forecast's margin when
 * that is more, the figure the ask before queuing and an MCP token's render_grid are held to.
 */

const plan = (pod: GridPlan["pod"], refused: string | null = null): GridPlan => ({ axes: [], error: null, count: 2, said: "2 renders", ms: 80 * 60_000, pod, refused, across: undefined, lists: {} });

describe("the grid card's cost on a pod", () => {
  it("says what it may cost beside the forecast when an unsure cell's margin makes it more", () => {
    draw(<GridCost plan={plan({ ms: 80 * 60_000, usd: 0.93, most: 1.28, fetch: null })} />);
    expect(screen.getByText(/about \$0\.93/).textContent).toMatch(/about \$0\.930?, up to \$1\.28/);
  });

  it("says the forecast alone when every cell's is sure", () => {
    draw(<GridCost plan={plan({ ms: 80 * 60_000, usd: 0.93, most: 0.93, fetch: null })} />);
    expect(screen.getByText(/about \$0\.93/).textContent).not.toMatch(/up to/);
  });

  it("says the model files the pod fetches first, each family's once (card #294), and a cell no machine can run", () => {
    draw(<GridCost plan={plan({ ms: 80 * 60_000, usd: 1.1, most: 1.1, fetch: { files: 3, bytes: 24.1 * 1024 ** 3, ms: 9 * 60_000 } }, "FLUX.2 Klein: flux-2-klein-4b: FLUX.2 Klein is switched off on pod-a")} />);
    expect(screen.getByText(/^Fetches 3 model files first/).textContent).toBe("Fetches 3 model files first: 24.1 GB, about 9 min");
    expect(screen.getByRole("alert").textContent).toMatch(/switched off/);
  });
});
