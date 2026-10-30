import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NOT_ANSWERING } from "../src/api";

/**
 * A success whose body is cut off on its way (the connection dropped mid-answer): the api client says the server is not
 * answering rather than handing on an empty answer as if it were the real one; a request given up on stays an abort.
 */

/** fetch answering with `status` and a body that breaks off after a few bytes with `err`. */
function cutOff(err: Error, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"lan'));
      c.error(err);
    },
  }), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => vi.unstubAllGlobals());

describe("a body cut off on its way", () => {
  it("is the server not answering, for a read", async () => {
    cutOff(new TypeError("terminated"));
    await expect(api.queue()).rejects.toThrow(NOT_ANSWERING);
  });
  it("is the server not answering, for an upload and a file's embedded settings", async () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    cutOff(new TypeError("terminated"));
    await expect(api.upload(file)).rejects.toThrow(NOT_ANSWERING);
    cutOff(new TypeError("terminated"));
    await expect(api.embedded(file)).rejects.toThrow(NOT_ANSWERING);
  });
  it("stays an abort when the request was given up on", async () => {
    cutOff(new DOMException("The operation was aborted.", "AbortError"));
    await expect(api.queue()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("still says a refusal by its status when its words were lost", async () => {
    cutOff(new TypeError("terminated"), 500);
    const err = await api.queue().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, message: "Something went wrong on the server (500): the console Afflatus runs in says what." });
  });
});
