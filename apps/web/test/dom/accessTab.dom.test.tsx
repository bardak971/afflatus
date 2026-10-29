import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Switch } from "wouter";
import { Setup } from "../../src/screens/Setup";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Access, a tab of its own (it was a card of Interface until 0.8.2): the card with its rows' anchors and Agents
 * (MCP), Interface without it, and the old links (?find= and #) to it on Interface sent on to the new tab.
 */

const access = { hasPassword: false, passwordSetAt: null, localNoPassword: false, stayDays: 30, resetTelegram: false, hasMetricsToken: false };
const notify = { hasTelegramToken: false, telegramChat: "", hasDiscordWebhook: false, picture: false, events: { newDevice: { telegram: false, discord: false } } };

function serve() {
  fakeApi.on("GET /settings", { machines: [], allFamilies: true, hasRunpodKey: false, access, notify });
  fakeApi.on("GET /session", { locked: false, session: null, localNoPassword: false });
  fakeApi.on("GET /session/devices", { listen: { host: "127.0.0.1", port: 8721, reach: "local" }, canBypass: true, alarm: null, devices: [] });
  fakeApi.on("GET /mcp/tokens", { tokens: [] });
}

const drawAt = (at: string) =>
  draw(
    <Switch>
      <Route path="/settings" component={Setup} />
      <Route path="/settings/:tab" component={Setup} />
    </Switch>,
    { at },
  );

const tab = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });

describe("Settings › Access", () => {
  it("is a tab after Interface, with the Access card and its anchors, Agents (MCP) among them", async () => {
    serve();
    const { container } = drawAt("/settings/access");
    expect(await screen.findByText(/No token yet/)).toBeTruthy();
    expect(tab("Access").getAttribute("aria-checked")).toBe("true");
    const labels = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(labels.indexOf("Access")).toBe(labels.indexOf("Interface") + 1);
    for (const key of ["access", "access.reach", "access.password", "access.local", "access.stay", "access.codes", "access.newDevice", "access.mcp"]) {
      expect(container.querySelector(`[data-setting~="${key}"]`), key).toBeTruthy();
    }
  });

  it("is no longer on Interface", async () => {
    serve();
    const { container } = drawAt("/settings/interface");
    expect(await screen.findByText("Appearance")).toBeTruthy();
    expect(container.querySelector('[data-setting~="access.password"]')).toBeNull();
    expect(screen.queryByText(/No token yet/)).toBeNull();
  });

  it("sends an old link to an Access row on Interface on to the Access tab, on that row", async () => {
    serve();
    const { location } = drawAt("/settings/interface?find=access.mcp");
    await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/access?find=access.mcp"));
    expect(await screen.findByText(/No token yet/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-found]")?.getAttribute("data-setting")).toContain("access.mcp"));
  });

  it("sends an old #access anchor on Interface on to the Access tab", async () => {
    serve();
    window.history.replaceState(null, "", "/settings/interface#access.password");
    try {
      const { location } = drawAt("/settings/interface");
      await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/access?find=access.password"));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("Find a setting finds the password on the Access tab", async () => {
    serve();
    const { user, location } = drawAt("/settings");
    await user.type(screen.getByLabelText("Find a setting"), "password");
    const found = await screen.findByRole("option", { name: /^Password/ });
    expect(found.textContent).toContain("Access");
    await user.click(found);
    await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/access?find=access.password"));
  });
});
