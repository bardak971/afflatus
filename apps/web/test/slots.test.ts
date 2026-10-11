import { describe, expect, it } from "vitest";
import { refusedFile } from "../src/PictureField";

describe("a file dropped on a media slot", () => {
  it("is taken when it is of the slot's kind", () => {
    expect(refusedFile({ name: "a.png", type: "image/png" }, "image")).toBeNull();
    expect(refusedFile({ name: "a.webm", type: "video/webm" }, "video")).toBeNull();
    expect(refusedFile({ name: "a.flac", type: "audio/flac" }, "audio")).toBeNull();
  });
  it("is refused in words otherwise, rather than left without a sign", () => {
    expect(refusedFile({ name: "notes.txt", type: "text/plain" }, "image")).toBe("notes.txt is not an image.");
    expect(refusedFile({ name: "a.png", type: "image/png" }, "video")).toBe("a.png is not a video.");
    expect(refusedFile({ name: "a.mp4", type: "video/mp4" }, "audio")).toBe("a.mp4 is not an audio file.");
  });
});
