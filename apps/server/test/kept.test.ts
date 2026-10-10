import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ShippedPresets } from "../src/presetFiles";
import { checkTag, loadTagsSoon } from "../src/tags";

const preset = (id: string, name: string) => JSON.stringify({ id, name, recipe: "sdxl.text-to-picture", inputs: {}, files: [] });

describe("the shipped presets", () => {
  it("are read once and kept while their files stay as they are, read again when one changes, comes or goes", () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-presets-"));
    try {
      writeFileSync(join(dir, "a.json"), preset("zz-test-a", "A"));
      const shipped = new ShippedPresets(dir);
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
