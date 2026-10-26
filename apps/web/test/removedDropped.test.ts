import { describe, expect, it } from "vitest";
import { droppedRemovedTakes } from "../src/timeline/removedDropped";

const part = (fromMs: number, toMs: number, takes: number) => ({ before: `c${fromMs}`, fromMs, toMs, clips: 1, takes });

describe("the takes of removed parts a re-cut or a moved In leaves behind (card #114)", () => {
  it("counts only the parts the new stretch no longer holds whole with something after them", () => {
    const parts = [part(2000, 4000, 1), part(9000, 12000, 2), part(20000, 24000, 3)];
    // a re-cut over 0 to 20 s: the last part lies past the last clip (kept with one a trim set aside)
    expect(droppedRemovedTakes(parts, 0, 20000)).toBe(3);
    // the In moved past the first part: it goes too
    expect(droppedRemovedTakes(parts, 5000, 30000)).toBe(1);
    // the In moved into a part: it is no longer held whole
    expect(droppedRemovedTakes(parts, 10000, 30000)).toBe(3);
    // all held, or none at all
    expect(droppedRemovedTakes(parts, 0, 30000)).toBe(0);
    expect(droppedRemovedTakes(undefined, 0, 30000)).toBe(0);
  });
});
