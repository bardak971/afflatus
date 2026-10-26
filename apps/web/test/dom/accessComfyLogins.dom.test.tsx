import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { AccessCard } from "../../src/screens/settings/AccessCard";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Settings › Access (review S5): signing a device out does not end the ComfyUI login it got through Open ComfyUI (the node
 * pack's cookie comes from the machine's token alone), and the list of devices says so, with the way to end it.
 */

const access = { hasPassword: true, passwordSetAt: "2026-10-20T10:00:00Z", localNoPassword: false, stayDays: 30, resetTelegram: false, hasMetricsToken: false };
const notify = { hasTelegramToken: false, telegramChat: "", hasDiscordWebhook: false, picture: false, events: { newDevice: { telegram: false, discord: false } } };
const phone = { id: "s2", name: "Safari on iPhone", firstSeen: "2026-10-25T09:00:00Z", ip: "192.168.1.20", lastSeen: "2026-10-26T09:00:00Z", remember: true, here: false };

describe("the devices signed in", () => {
  it("say that a ComfyUI opened from one outlives its sign-out, and that renewing the token ends it", async () => {
    fakeApi.on("GET /settings", { machines: [], access, notify });
    fakeApi.on("GET /session", { locked: true, session: "s1", localNoPassword: false });
    fakeApi.on("GET /session/devices", { listen: { host: "0.0.0.0", port: 8721, reach: "network" }, canBypass: true, alarm: null, devices: [phone] });
    draw(<AccessCard />);
    expect(await screen.findByText("Safari on iPhone")).toBeTruthy();
    expect(screen.getByText(/stays open in that browser once it is signed out here: renew that machine's token/)).toBeTruthy();
  });
});
