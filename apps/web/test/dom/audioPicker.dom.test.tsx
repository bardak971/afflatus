import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Picker } from "../../src/PictureField";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The Picker of an audio slot (B14): the videos with sound are asked of the server, not sorted out of a page of every video,
 * where a page of silent renders showed none and never drew the button that reads the next one.
 */

const video = (id: string, name: string, hasSound: boolean) => ({
  id, kind: "video", origin: "generated", name, mime: "video/mp4", bytes: 1, width: 64, height: 64, durationMs: 4000, fps: 24,
  hasSound, kept: false, inBin: false, folderId: null, generationId: null, createdAt: "2026-10-26T10:00:00Z", path: null,
});

describe("an audio slot's Picker", () => {
  it("lists a video with sound made before a page of silent renders", async () => {
    fakeApi.on("GET /assets", () => {
      // the request just asked, with its query (the stand-in's routes are matched without it)
      const query = new URLSearchParams(fakeApi.calls("GET", "/assets?").at(-1)!.path.split("?")[1]);
      if (query.get("kind") !== "video") return { items: [], next: null, prev: null };
      if (query.get("sound") === "1") return { items: [video("zz-sung", "zz-test sung", true)], next: null, prev: null };
      return { items: Array.from({ length: 40 }, (_, i) => video(`zz-silent-${i}`, `zz-test silent ${i}`, false)), next: "page-2", prev: null };
    });
    draw(<Picker title="Audio" kind="audio" onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Use the audio of zz-test sung" })).toBeTruthy();
    expect(screen.queryByText("No audio files yet")).toBeNull();
  });
});
