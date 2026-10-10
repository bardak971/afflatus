import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngText } from "../src/screens/pngText";

/** A PNG made of its signature and the given chunks (the CRCs are not read). */
function png(chunks: Array<[string, Uint8Array]>): Uint8Array {
  const parts: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const [type, data] of [...chunks, ["IEND", new Uint8Array()] as [string, Uint8Array]]) {
    parts.push((data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0);
  }
  return new Uint8Array(parts);
}
const bytes = (...parts: Array<string | number[] | Uint8Array>) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : [...p])));

describe("the workflow ComfyUI writes into a picture", () => {
  it("is read from plain and compressed text chunks alike", async () => {
    const text = await pngText(png([
      ["tEXt", bytes("prompt", [0], "{}")],
      ["zTXt", bytes("workflow", [0, 0], deflateSync('{"nodes":[]}'))],
      ["iTXt", bytes("extra", [0, 1, 0, 0, 0], deflateSync("packed"))],
      ["iTXt", bytes("plain", [0, 0, 0, 0, 0], "as is")],
    ]));
    expect(text).toEqual({ prompt: "{}", workflow: '{"nodes":[]}', extra: "packed", plain: "as is" });
  });

  it("is not unpacked past a megabyte: a few kilobytes of a stranger's file can unpack to gigabytes", async () => {
    // 64 MB of one letter packs into about 64 kB
    const bomb = png([["zTXt", bytes("workflow", [0, 0], deflateSync(new Uint8Array(64 << 20).fill(97)))], ["tEXt", bytes("prompt", [0], "{}")]]);
    expect(bomb.length).toBeLessThan(200_000);
    const start = performance.now();
    expect(await pngText(bomb)).toEqual({ workflow: "", prompt: "{}" });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
