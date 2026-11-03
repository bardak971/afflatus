import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, sha256File, sleep } from "../src/fsUtil";

/** The helpers the server had written several times over (card #261), each with what its copies disagreed on. */
describe("fsUtil", () => {
  it("says a path is inside a root by its segments: a folder named ..x inside it is inside", () => {
    const root = join(tmpdir(), "zz-test-root");
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "a", "b.safetensors"))).toBe(true);
    // the downloader's copy tested the text "..", and refused this folder of the models folder
    expect(isInside(root, join(root, "..x", "b.safetensors"))).toBe(true);
    expect(isInside(root, join(root, "..", "other"))).toBe(false);
    expect(isInside(root, join(root, "a", "..", "..", "other"))).toBe(false);
    expect(isInside(root, `${root}-sibling`)).toBe(false);
    if (process.platform === "win32") {
      expect(isInside("C:\\Models", "D:\\Models\\x.safetensors")).toBe(false);
      expect(isInside("C:\\Models", "c:\\models\\SDXL\\x.safetensors")).toBe(true);
    }
  });

  it("hashes a file, upper case as Civitai lists it when asked", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "zz-test-sha-")), "a.bin");
    writeFileSync(path, "abc");
    const hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256File(path)).toBe(hex);
    expect(await sha256File(path, { upper: true })).toBe(hex.toUpperCase());
  });

  it("waits, and stops waiting when its signal aborts", async () => {
    const stop = new AbortController();
    const from = Date.now();
    setTimeout(() => stop.abort(), 20);
    await sleep(30_000, stop.signal);
    expect(Date.now() - from).toBeLessThan(5000);
    const aborted = AbortSignal.abort();
    await sleep(30_000, aborted);
  });
});
