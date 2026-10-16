import { describe, expect, it } from "vitest";
import { parseSceneTimes } from "../src/measure";

describe("where a video cuts between shots", () => {
  it("reads the moments from ffmpeg's showinfo lines, in order, skipping the start and near-duplicates", () => {
    const log = [
      "[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration: 1 pos: 1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  54000 pts_time:4.5     duration: 1 pos: 2 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x1] n:   2 pts:  56000 pts_time:4.667   duration: 1 pos: 3 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x1] n:   3 pts: 120000 pts_time:10.0    duration: 1 pos: 4 fmt:yuv420p",
      "frame=   3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:12.00",
    ].join("\n");
    expect(parseSceneTimes(log)).toEqual([4500, 10000]);
    expect(parseSceneTimes("")).toEqual([]);
  });
});
