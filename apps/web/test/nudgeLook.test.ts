import { describe, expect, it } from "vitest";
import { lightFilter, svgFiltersOnVideo } from "../src/timeline/nudgeLook";

/** A CSS filter list of contrast() and brightness() applied to one channel value, 0 to 1, each step kept within 0 and 1. */
function apply(filter: string, x: number): number {
  let v = x;
  for (const [, fn, arg] of filter.matchAll(/(contrast|brightness)\(([\d.]+)\)/g)) {
    const k = Number(arg);
    v = fn === "contrast" ? (v - 0.5) * k + 0.5 : v * k;
    v = Math.min(1, Math.max(0, v));
  }
  return v;
}

describe("the colour nudge where a video takes no SVG filter", () => {
  it("adds the nudge's light to every level, as the export's lutyuv does, within 0 and 255", () => {
    for (const y of [-14, -6, -1, 1, 3, 14]) {
      const f = lightFilter(y);
      for (const level of [0, 4, 16, 64, 128, 200, 235, 251, 255]) {
        const want = Math.min(255, Math.max(0, level + y));
        expect(apply(f, level / 255) * 255, `${y} at ${level}`).toBeCloseTo(want, 2);
      }
    }
  });

  it("is nothing without a nudge", () => {
    expect(lightFilter(0)).toBe("");
  });

  it("is used on WebKit's browsers only: Safari and any browser on an iPhone, not Chrome, Edge or Firefox", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
    const iphoneChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1";
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const edge = `${chrome} Edg/142.0.0.0`;
    const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0";
    expect([safari, iphoneChrome, chrome, edge, firefox].map((ua) => svgFiltersOnVideo(ua))).toEqual([false, false, true, true, true]);
  });
});
