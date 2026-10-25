import { UPLOAD_MAX_BYTES } from "@afflatus/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";

/**
 * A file over the upload limit is refused in words before anything is sent: the server stops reading past the limit, and
 * a browser still sending then shows a dropped connection (ERR_CONNECTION_RESET), never the server's 413.
 */

/** A file that says it weighs `bytes`, without holding them. */
function weighing(name: string, type: string, bytes: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

afterEach(() => vi.unstubAllGlobals());

describe("a file over the upload limit", () => {
  it("is refused with its size and the limit, nothing sent, for an upload and a file's embedded settings", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const big = weighing("long-4k.mp4", "video/mp4", UPLOAD_MAX_BYTES + 1);
    const err = await api.upload(big).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe("long-4k.mp4 is 4.0 GB: Afflatus takes up to 4.0 GB in one upload.");
    await expect(api.embedded(big)).rejects.toThrow(/takes up to 4\.0 GB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a file of the limit itself through, as large as a long 4K video", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "a1" }), { status: 200, headers: { "Content-Type": "application/json" } })));
    expect(UPLOAD_MAX_BYTES).toBeGreaterThan(512 * 2 ** 20);
    await expect(api.upload(weighing("clip.mp4", "video/mp4", UPLOAD_MAX_BYTES))).resolves.toMatchObject({ id: "a1" });
  });
});
