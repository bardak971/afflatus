import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Switch } from "wouter";
import { Setup } from "../../src/screens/Setup";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Sign-in and Agents (MCP) (card #168: the Access tab, split, as Interface's Access card was in 0.8.2): their
 * cards with their rows' anchors, Interface and Sign-in without the tokens, and the old links (?find=, # and the old tab's
 * address) sent on to the tab that has the row now.
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

describe("Settings › Sign-in and Agents (MCP)", () => {
  it("are tabs after Notifications, Sign-in with its rows' anchors, Agents (MCP) with the tokens", async () => {
    serve();
    const { container } = drawAt("/settings/signin");
    await waitFor(() => expect(container.querySelector('[data-setting~="access.reach"]')).toBeTruthy());
    expect(tab("Sign-in").getAttribute("aria-checked")).toBe("true");
    const labels = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(labels.indexOf("Sign-in")).toBe(labels.indexOf("Notifications") + 1);
    expect(labels.indexOf("Agents (MCP)")).toBe(labels.indexOf("Sign-in") + 1);
    for (const key of ["access", "access.reach", "access.password", "access.local", "access.stay", "access.codes", "access.newDevice"]) {
      expect(container.querySelector(`[data-setting~="${key}"]`), key).toBeTruthy();
    }
    // the new device's notice is set in Notifications › What alone: here its state, and the way there
    expect(screen.getByText("not told")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Notifications › What/ }).getAttribute("href")).toBe("/settings/notifications?find=notify.newDevice");
    expect(screen.queryByText(/No token yet/)).toBeNull();
  });

  it("has the tokens on Agents (MCP), and none on Interface", async () => {
    serve();
    const { container } = drawAt("/settings/agents");
    expect(await screen.findByText(/No token yet/)).toBeTruthy();
    expect(container.querySelector('[data-setting~="access.mcp"]')).toBeTruthy();
    serve();
    const other = drawAt("/settings/interface");
    expect(await screen.findAllByText("Appearance")).toBeTruthy();
    expect(other.container.querySelector('[data-setting~="access.password"]')).toBeNull();
    expect(other.container.querySelector('[data-setting~="access.mcp"]')).toBeNull();
  });

  it("sends an old link to the tokens on to Agents (MCP), on that row", async () => {
    serve();
    const { location } = drawAt("/settings/access?find=access.mcp");
    await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/agents?find=access.mcp"));
    expect(await screen.findByText(/No token yet/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-found]")?.getAttribute("data-setting")).toContain("access.mcp"));
  });

  it("sends an old #access anchor on Interface on to Sign-in", async () => {
    serve();
    window.history.replaceState(null, "", "/settings/interface#access.password");
    try {
      const { location } = drawAt("/settings/interface");
      await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/signin?find=access.password"));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("puts the old tab's address right", async () => {
    serve();
    const { location } = drawAt("/settings/access");
    await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/signin"));
  });

  it("Find a setting finds the password on Sign-in", async () => {
    serve();
    const { user, location } = drawAt("/settings");
    await user.type(screen.getByLabelText("Find a setting"), "password");
    const found = await screen.findByRole("option", { name: /^Password/ });
    expect(found.textContent).toContain("Sign-in");
    await user.click(found);
    await waitFor(() => expect(location.history!.at(-1)).toBe("/settings/signin?find=access.password"));
  });
});
