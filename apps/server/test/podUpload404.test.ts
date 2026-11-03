import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PASSING } from "../src/downloads";
import { uploadFile } from "../src/podUpload";

/**
 * The upload's start answered 404 (card #235): an empty one is the pod's proxy, ComfyUI not behind it for a moment (asked
 * again); ComfyUI's own has a body, its Afflatus pack not loaded, and asking again gets the same: failed at once, never four
 * tries holding the pod's idle stop.
 */
describe("a 404 to the node pack's upload start", () => {
  const path = join(mkdtempSync(join(tmpdir(), "afflatus-up404-")), "a.safetensors");
  writeFileSync(path, Buffer.alloc(1000, 1));
  const send = (body: string) => uploadFile({ client: { raw: async () => new Response(body || null, { status: 404 }) }, path, folder: "loras", file: "a.safetensors", signal: new AbortController().signal });

  it("an empty one is the pod's proxy: a failure that passes", async () => {
    const err = await send("").catch((e: Error) => e);
    expect(PASSING.test((err as Error).message)).toBe(true);
  });

  it("ComfyUI's own, with its body, says the pack's route is not there: not a failure that passes", async () => {
    const err = await send("404: Not Found").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/has no Afflatus node pack upload route \(404: 404: Not Found\)/);
    expect(PASSING.test((err as Error).message)).toBe(false);
  });
});
