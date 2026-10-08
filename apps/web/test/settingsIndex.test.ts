import { describe, expect, it } from "vitest";
import { INDEX, MOVED, TABS } from "../src/screens/settings/settingsIndex";

const ids = TABS.map((t) => t.id as string);

describe("settings index", () => {
  it("files every setting under a tab that exists", () => {
    expect(INDEX.filter((i) => !ids.includes(i.tab))).toEqual([]);
  });

  // Appearance and Notifications were merged into Interface: their old addresses still open it
  it("sends the merged tabs' old ids to Interface", () => {
    expect(MOVED.appearance).toBe("interface");
    expect(MOVED.notifications).toBe("interface");
    for (const to of Object.values(MOVED)) expect(ids).toContain(to);
    for (const from of Object.keys(MOVED)) expect(ids).not.toContain(from);
  });

  it("finds the merged tabs' settings on Interface", () => {
    const onInterface = INDEX.filter((i) => i.tab === "interface").map((i) => i.label);
    expect(onInterface).toEqual(expect.arrayContaining(["Theme", "Explain every setting in the forms", "Notify after each render", "Notify when the queue is empty"]));
  });
});
