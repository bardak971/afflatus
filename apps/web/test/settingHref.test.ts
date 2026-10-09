import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX, settingHref, spotOf } from "../src/screens/settings/settingsIndex";

const dir = join(__dirname, "../src/screens/settings");
// every data-setting the Settings cards carry ("a b" is two anchors on one row)
const anchors = new Set(
  readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/setting="([^"]+)"/g)].flatMap((m) => m[1]!.split(" "))),
);

describe("a setting's address", () => {
  it("opens its tab and names the row to find", () => {
    expect(settingHref("comfy.unload")).toBe("/settings?find=comfy.unload");
    expect(settingHref("storage.bin")).toBe("/settings/storage?find=storage.bin");
  });

  it("takes the command bar's id of the same setting", () => {
    expect(settingHref("theme.night")).toBe("/settings/interface?find=interface.theme");
    expect(settingHref("server.updateChecks")).toBe("/settings/models?find=models.updates");
  });

  it("opens the tab, or Settings, for a key it does not know", () => {
    expect(settingHref("nope", "bar")).toBe("/settings/bar");
    expect(settingHref("nope")).toBe("/settings");
  });

  it("has one key per setting, each carried by a row of its page (or landing near one)", () => {
    const keys = INDEX.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of INDEX) {
      expect(anchors.has(i.key) || Boolean(i.near && anchors.has(i.near)), i.key).toBe(true);
      if (i.near) expect(spotOf(i.near), i.near).toBeTruthy();
    }
  });
});
