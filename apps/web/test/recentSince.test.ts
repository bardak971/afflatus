import { describe, expect, it } from "vitest";
import { recentSince } from "../src/screens/studio/useLibraryFilters";

describe("the Recent filter's cutoff", () => {
  it("is two days before the hour it is now, and moves on with the time", () => {
    const at = Date.parse("2026-10-10T12:34:56.000Z");
    expect(recentSince(at)).toBe("2026-10-08T12:00:00.000Z");
    // the same within the hour (the list is not asked again at every drawing), the next hour's after it
    expect(recentSince(at + 20 * 60_000)).toBe("2026-10-08T12:00:00.000Z");
    expect(recentSince(at + 30 * 60_000)).toBe("2026-10-08T13:00:00.000Z");
    expect(recentSince(at + 24 * 3_600_000)).toBe("2026-10-09T12:00:00.000Z");
  });
});
