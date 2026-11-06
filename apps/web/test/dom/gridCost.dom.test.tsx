import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { GridCost } from "../../src/grid/GridCard";
import type { GridPlan } from "../../src/grid/gridPlan";
import { draw } from "./render";

/**
 * The grid card's money line (card #328): the plain forecast, and what it may cost with an unsure forecast's margin when
 * that is more, the figure the ask before queuing and an MCP token's render_grid are held to.
 */

const plan = (pod: GridPlan["pod"]): GridPlan => ({ axes: [], error: null, count: 2, said: "2 renders", ms: 80 * 60_000, pod });

describe("the grid card's cost on a pod", () => {
  it("says what it may cost beside the forecast when an unsure cell's margin makes it more", () => {
    draw(<GridCost plan={plan({ ms: 80 * 60_000, usd: 0.93, most: 1.28 })} />);
    expect(screen.getByText(/about \$0\.93/).textContent).toMatch(/about \$0\.930?, up to \$1\.28/);
  });

  it("says the forecast alone when every cell's is sure", () => {
    draw(<GridCost plan={plan({ ms: 80 * 60_000, usd: 0.93, most: 0.93 })} />);
    expect(screen.getByText(/about \$0\.93/).textContent).not.toMatch(/up to/);
  });
});
