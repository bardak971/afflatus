import { describe, expect, it } from "vitest";
import { INDEX, MOVED, TABS } from "../src/screens/settings/settingsIndex";

const ids = TABS.map((t) => t.id as string);
/** The labels of a tab's settings, as Find a setting lists them. */
const on = (tab: string) => INDEX.filter((i) => i.tab === tab).map((i) => i.label);

describe("settings index", () => {
  it("files every setting under a tab that exists", () => {
    expect(INDEX.filter((i) => !ids.includes(i.tab))).toEqual([]);
  });

  // Appearance (0.4) and the Command bar (card #168) were merged into Interface, the Designer into Prompts, Access renamed
  // Sign-in: their old addresses still open the tab that has them. Notifications was merged into Interface, then had a tab
  // of its own again (card #168): its address is a tab's
  it("sends the merged tabs' old ids to the tab that has them", () => {
    expect(MOVED).toEqual({ appearance: "interface", bar: "interface", designer: "prompts", access: "signin" });
    expect(ids).toContain("notifications");
    for (const to of Object.values(MOVED)) expect(ids).toContain(to);
    for (const from of Object.keys(MOVED)) expect(ids).not.toContain(from);
  });

  it("finds the merged tabs' settings where they went", () => {
    expect(on("interface")).toEqual(expect.arrayContaining(["Dark theme · Light theme", "Explain every setting in the forms", "Shortcut", "Prompt snippets"]));
    expect(on("notifications")).toEqual(expect.arrayContaining(["Notify: render done", "Notify: queue empty", "Telegram", "Discord", "Banner when renders finish"]));
    expect(on("prompts")).toEqual(expect.arrayContaining(["LLMs", "System prompts", "Danbooru tag check"]));
    expect(on("costs")).toEqual(expect.arrayContaining(["Electricity: price a kWh", "Spending caps"]));
    expect(on("model-files")).toEqual(expect.arrayContaining(["Your models online", "Model sets", "Newer versions on Civitai"]));
    expect(on("about")).toEqual(expect.arrayContaining(["First launch: show it again"]));
  });

  it("names a row of ComfyUI once (card #168): ComfyUI token, Afflatus node pack, Missing node packs", () => {
    expect(on("comfyui")).toEqual(expect.arrayContaining(["ComfyUI token", "Afflatus node pack", "Missing node packs"]));
  });
});
