import { describe, expect, it } from "vitest";
import { axisLabels } from "../src/screens/queue/chartMath";

describe("the left axis's labels", () => {
  it("keep the chart's format when they differ", () => {
    expect(axisLabels([0, 50, 100], (v) => `${v.toFixed(0)} %`)).toEqual(["0 %", "50 %", "100 %"]);
  });
  it("take more decimals, the unit kept, when gridlines close together round alike", () => {
    const fmt = (v: number) => `${v.toFixed(v < 10 ? 0 : 0)} min/s`;
    expect(axisLabels([2.8, 2.9, 3, 3.1, 3.2], fmt)).toEqual(["2.8 min/s", "2.9 min/s", "3.0 min/s", "3.1 min/s", "3.2 min/s"]);
    expect(axisLabels([0.01, 0.015, 0.02], (v) => `${v.toFixed(1)} s/MP`)).toEqual(["0.010 s/MP", "0.015 s/MP", "0.020 s/MP"]);
  });
});
