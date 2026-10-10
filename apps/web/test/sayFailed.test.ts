import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { failedBanner } from "../src/sayFailed";

describe("a failed action's banner", () => {
  it("says the error's own words, with the way to the library unless told", () => {
    expect(failedBanner({}, "Could not be moved", new Error("gone"), 5)).toEqual({ id: "failed:5", tone: "bad", title: "Could not be moved", text: "gone", href: "/", go: "Open the library" });
    expect(failedBanner({ id: "queue", href: "/queue", go: "Open queue" }, "Not cancelled", "refused", 7)).toMatchObject({ id: "queue:7", text: "refused", href: "/queue", go: "Open queue" });
  });
  it("titles a 409 as still in use where the place asks for it, and only there", () => {
    const busy = new ApiError("A clip of Harbour uses it.", 409);
    expect(failedBanner({ inUse: true }, "Could not be deleted", busy).title).toBe("Still in use");
    expect(failedBanner({}, "Could not be deleted", busy).title).toBe("Could not be deleted");
    expect(failedBanner({ inUse: true }, "Could not be deleted", new ApiError("no", 500)).title).toBe("Could not be deleted");
  });
});
