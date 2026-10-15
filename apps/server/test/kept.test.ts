import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ShippedPresets } from "../src/presetFiles";
import { checkTag, loadTagsSoon } from "../src/tags";

const preset = (id: string, name: string) => JSON.stringify({ id, name, recipe: "sdxl.text-to-picture", inputs: {}, files: [] });

describe("the shipped presets", () => {
  it("are read once and kept while their files stay as they are, read again when one changes, comes or goes", () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-presets-"));
    try {
      writeFileSync(join(dir, "a.json"), preset("zz-test-a", "A"));
      // looked at on every call here: the wait between two looks is the next test's
      const shipped = new ShippedPresets(dir, 0);
      const first = shipped.list();
      expect(first.map((p) => p.name)).toEqual(["A"]);
      // nothing changed: the same list, not read again
      expect(shipped.list()).toBe(first);
      writeFileSync(join(dir, "a.json"), preset("zz-test-a", "A renamed"));
      utimesSync(join(dir, "a.json"), new Date(), new Date(Date.now() + 5000));
      expect(shipped.list().map((p) => p.name)).toEqual(["A renamed"]);
      writeFileSync(join(dir, "b.json"), preset("zz-test-b", "B"));
      expect(shipped.list().map((p) => p.name)).toEqual(["A renamed", "B"]);
      rmSync(join(dir, "a.json"));
      expect(shipped.list().map((p) => p.name)).toEqual(["B"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are looked at once every few seconds at most: where a pod gets each file of a search asks for them", () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-presets-"));
    let clock = Date.parse("2026-10-15T12:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      writeFileSync(join(dir, "a.json"), preset("zz-test-a", "A"));
      const shipped = new ShippedPresets(dir, 5_000);
      expect(shipped.list().map((p) => p.name)).toEqual(["A"]);
      // a file added a moment later is not looked for yet: the folder is not listed again on every call
      writeFileSync(join(dir, "b.json"), preset("zz-test-b", "B"));
      clock += 4_000;
      expect(shipped.list().map((p) => p.name)).toEqual(["A"]);
      clock += 1_500;
      expect(shipped.list().map((p) => p.name)).toEqual(["A", "B"]);
    } finally {
      now.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the tag list", () => {
  it("is read in the background, and a check then finds it ready", async () => {
    await loadTagsSoon();
    const t = performance.now();
    expect(checkTag("1girl").status).toBe("ok");
    // read already: the check itself takes no time to speak of
    expect(performance.now() - t).toBeLessThan(50);
  });
});
