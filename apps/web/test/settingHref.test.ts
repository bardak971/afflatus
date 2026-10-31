import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX, landing, MOVED, settingHref, spotOf, TABS } from "../src/screens/settings/settingsIndex";

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
    expect(settingHref("server.updateChecks")).toBe("/settings/model-files?find=models.updates");
  });

  it("opens the tab, or Settings, for a key it does not know", () => {
    expect(settingHref("nope", "agents")).toBe("/settings/agents");
    expect(settingHref("nope")).toBe("/settings");
  });

  it("has one key per setting, each carried by a row of its page (or landing near one)", () => {
    const keys = INDEX.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of INDEX) {
      expect(anchors.has(i.key) || Boolean(i.near && anchors.has(i.near)), i.key).toBe(true);
      if (i.near) expect(spotOf(i.near), i.near).toBeTruthy();
      // Settings looks for the near row on the setting's own tab only: one on another tab lands on nothing outlined
      if (i.near) expect(spotOf(i.near)?.tab, `${i.key} near ${i.near}`).toBe(i.tab);
    }
  });
});

/** Every setting of Settings before card #168 laid its tabs out again, on the tab it was on then (a link to it may be anywhere). */
const BEFORE_168: Array<[string, string]> = [
  ["comfyui", "comfy.url"], ["comfyui", "comfy.packs"], ["comfyui", "comfy.machines"], ["comfyui", "comfy.folder"], ["comfyui", "comfy.runpod"], ["comfyui", "costs.kwh"],
  ["rented", "comfy.rentcaps"], ["rented", "rented.key"], ["rented", "rented.pods"], ["rented", "rented.volumes"], ["rented", "rented.next"], ["rented", "rented.s3"], ["rented", "rented.unused"], ["rented", "rented.bootlogs"],
  ["comfyui", "comfy.access"], ["comfyui", "comfy.version"], ["comfyui", "comfy.pack"], ["comfyui", "comfy.unload"], ["model-files", "modelFiles.list"],
  ["models", "models.families"], ["models", "models.files"], ["models", "models.civitaiKey"], ["models", "models.online"], ["models", "models.huggingFaceToken"], ["models", "server.civitaiLookups"],
  ["models", "server.downloadModels"], ["models", "models.downloads"], ["models", "models.sets"], ["models", "models.link"], ["models", "models.updates"],
  ["designer", "designer.llms"], ["designer", "designer.notes"], ["prompts", "prompts.guides"], ["designer", "designer.context"], ["designer", "designer.tokens"], ["designer", "designer.forget"],
  ["prompts", "server.tagCheck"], ["prompts", "prompts.wildcards"],
  ["interface", "interface.theme"], ["interface", "interface.accent"], ["interface", "interface.progress"], ["interface", "explain"], ["interface", "hover.video"], ["interface", "hover.sound"], ["interface", "compare.result"], ["interface", "interface.pins"],
  ["bar", "bar.shortcut"], ["bar", "bar.learn"], ["bar", "bar.preview"], ["bar", "bar.forget"], ["bar", "bar.snippets"], ["bar", "bar.cast"],
  ["storage", "storage.disk"], ["storage", "storage.bin"], ["storage", "storage.unkeptDays"], ["storage", "storage.binDays"], ["storage", "storage.jobDays"], ["storage", "storage.idle"], ["storage", "storage.renderTimes"], ["storage", "storage.forgetTimes"], ["storage", "storage.backup"],
  ["interface", "notify.banner"], ["interface", "notify.browser"], ["interface", "notify.telegram"], ["interface", "notify.discord"], ["interface", "notify.what"], ["interface", "notify.picture"],
  ["interface", "notify.renderDone"], ["interface", "notify.renderFailed"], ["interface", "notify.queueEmpty"], ["interface", "notify.renderStuck"], ["interface", "notify.podStopped"], ["interface", "notify.capReached"],
  ["interface", "notify.balanceLow"], ["interface", "notify.gpuFound"], ["interface", "notify.huntGaveUp"], ["interface", "notify.comfyGone"], ["interface", "notify.newDevice"],
  ["access", "access.password"], ["access", "access.reach"], ["access", "access.local"], ["access", "access.stay"], ["access", "access.codes"], ["access", "access.newDevice"], ["access", "access.metrics"], ["access", "access.mcp"], ["access", "access"],
  ["about", "about.version"], ["about", "about.updates"], ["about", "about.checks"],
];

describe("an old link (card #168)", () => {
  it("names a tab that is still there, or one moved to a tab that is", () => {
    const ids = TABS.map((t) => t.id as string);
    for (const [old] of BEFORE_168) expect(ids.includes(old) || ids.includes(MOVED[old] ?? ""), old).toBe(true);
    for (const to of Object.values(MOVED)) expect(ids).toContain(to);
  });

  it("lands every setting it found on the tab that has it now, with its row to find", () => {
    for (const [old, key] of BEFORE_168) {
      const spot = spotOf(key);
      expect(spot, key).toBeTruthy();
      expect(anchors.has(spot!.key) || Boolean(spot!.near && anchors.has(spot!.near)), key).toBe(true);
      // /settings/<old>?find=<key>, then wherever it is sent on, lands on the tab with the row
      let at = landing(old, key);
      for (let hops = 0; at.to && hops < 3; hops++) {
        const url = new URL(at.to, "http://x");
        at = landing(url.pathname.split("/")[2], url.searchParams.get("find"));
      }
      expect(at.to, `${old} ${key}`).toBeNull();
      expect(at.tab, `${old} ${key}`).toBe(spot!.tab);
    }
  });

  it("puts an old tab's address right, and lands the moved settings where the mock put them", () => {
    expect(landing("access", null)).toEqual({ tab: "signin", to: "/settings/signin" });
    expect(landing("bar", null)).toEqual({ tab: "interface", to: "/settings/interface" });
    expect(landing("designer", null)).toEqual({ tab: "prompts", to: "/settings/prompts" });
    expect(landing("appearance", null)).toEqual({ tab: "interface", to: "/settings/interface" });
    expect(landing("access", "access.mcp").to).toBe("/settings/agents?find=access.mcp");
    expect(landing("access", "access.newDevice").to).toBe("/settings/notifications?find=notify.newDevice");
    expect(landing("interface", "notify.what").to).toBe("/settings/notifications?find=notify.what");
    expect(landing("comfyui", "costs.kwh").to).toBe("/settings/costs?find=costs.kwh");
    expect(landing("rented", "comfy.rentcaps").to).toBe("/settings/costs?find=comfy.rentcaps");
    expect(landing("models", "models.sets").to).toBe("/settings/model-files?find=models.sets");
    expect(landing("access", "access.password").to).toBe("/settings/signin?find=access.password");
    expect(landing("rented", null)).toEqual({ tab: "rented", to: null });
    expect(landing(undefined, null)).toEqual({ tab: "comfyui", to: null });
  });
});
