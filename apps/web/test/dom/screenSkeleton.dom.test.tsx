import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SETTING_TABS } from "@afflatus/core";
import { ScreenSkeleton } from "../../src/ScreenSkeleton";
import { TimelineCardsWaiting } from "../../src/screens/studio/timelineShape";
import { draw } from "./render";

/** A screen whose code is on its way (card #179): its header and Settings' tabs at once, not a bare "Loading…". */
describe("a screen while its code comes", () => {
  it("draws Settings' title and every tab, the one asked picked", () => {
    draw(<ScreenSkeleton path="/settings/storage" />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    for (const t of SETTING_TABS) expect(screen.getByRole("radio", { name: t.label })).toBeTruthy();
    expect(screen.getByRole("radio", { name: SETTING_TABS.find((t) => t.id === "storage")!.label }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Loading…")).toBeNull();
  });
  it("draws the Queue's title, and no tabs of Settings", () => {
    draw(<ScreenSkeleton path="/queue" />);
    expect(screen.getByRole("heading", { name: "Queue" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });
  it("holds the timelines list's place with placeholder cards", () => {
    const { container } = draw(<TimelineCardsWaiting size="M" />);
    expect(container.querySelectorAll("[aria-busy] > div").length).toBeGreaterThan(1);
  });
});
