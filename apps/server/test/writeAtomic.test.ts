import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomic } from "../src/updatesModel";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("a small file written whole or not at all", () => {
  it("is one write or the other when two are made at once (Check again and Get ffmpeg's check), never both mixed", async () => {
    dir = await mkdtemp(join(tmpdir(), "zz-test-atomic-"));
    const path = join(dir, "ffmpeg-check.json");
    const a = "a".repeat(2 ** 20);
    const b = "b".repeat(2 ** 19);
    for (let i = 0; i < 5; i++) {
      await Promise.all([writeAtomic(path, a), writeAtomic(path, b)]);
      expect([a, b]).toContain(await readFile(path, "utf8"));
    }
    // and no temporary file left beside it
    expect(await readdir(dir)).toEqual(["ffmpeg-check.json"]);
  });
});
