import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { FfmpegGetView, HealthCheck } from "../../src/api";
import { AboutCard } from "../../src/screens/settings/AboutCard";
import { useMissingTools } from "../../src/App";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

const failed: HealthCheck = {
  id: "ffmpeg", label: "ffmpeg", ok: false, detail: "7.1 (PATH) cut 21 frames where 22 were asked (at 24 fps)",
  without: "Trims, exports, joins…", fix: "Get ffmpeg downloads one into Afflatus's data folder; or install it…", get: "download",
};
const health = (checks: HealthCheck[]) => ({ ok: true, version: "0.6.2", database: "sqlite", checks, checkedAt: null });
const get = (over: Partial<FfmpegGetView>): FfmpegGetView => ({ phase: "idle", bytes: 0, total: 194 * 2 ** 20, error: null, ...over });

describe("Get ffmpeg in Settings › About", () => {
  it("downloads the build when the check fails, says how far it is, then reads the checks again", async () => {
    let now = get({});
    fakeApi.on("GET /health", health([failed]));
    fakeApi.on("GET /ffmpeg/get", () => now);
    fakeApi.on("POST /ffmpeg/get", () => (now = get({ phase: "downloading", bytes: 97 * 2 ** 20 })));
    draw(<AboutCard />);
    expect(await screen.findByText(/BtbN's GPL build, 194 MB, into the data folder/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get ffmpeg" }));
    expect(await screen.findByText("Downloading ffmpeg · 97 MB of 194 MB")).toBeTruthy();
    // the server put it in place and its checks passed: About reads them again
    now = get({ phase: "done", bytes: 194 * 2 ** 20 });
    fakeApi.on("GET /health", health([{ ...failed, ok: true, detail: "9.0.2 (Get ffmpeg's)", get: undefined, note: "ffmpeg 7.1 on your PATH cut 21 frames where 22 were asked (at 24 fps): using Get ffmpeg's ffmpeg 9.0.2 instead." }]));
    expect(await screen.findByText("9.0.2 (Get ffmpeg's)", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/using Get ffmpeg's ffmpeg 9\.0\.2 instead/)).toBeTruthy();
    await waitFor(() => expect(fakeApi.calls("GET", "/health").length).toBeGreaterThan(1));
  });

  it("gives Homebrew's line on macOS, and nothing to get when the check passed", async () => {
    fakeApi.on("GET /health", health([{ ...failed, get: "brew" }, { id: "ffprobe", label: "ffprobe", ok: true, detail: "9.0.2", without: "", fix: "" }]));
    draw(<AboutCard />);
    expect(await screen.findByText("brew install ffmpeg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get ffmpeg" })).toBeNull();
    expect(fakeApi.calls("GET", "/ffmpeg/get")).toHaveLength(0);
  });

  it("offers no Get ffmpeg to a page on another computer, where it is refused: About, the first launch and the banner say where", async () => {
    sessionStorage.clear();
    fakeApi.on("GET /health", { ...health([failed]), here: false });
    const Banner = () => (useMissingTools(), null);
    draw(<><AboutCard /><Banner /></>);
    expect(await screen.findByText("Get ffmpeg from the PC Afflatus runs on.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get ffmpeg" })).toBeNull();
    await waitFor(() => expect(useBanners.getState().items.find((b) => b.id === "check-ffmpeg")?.text).toMatch(/Get ffmpeg from the PC Afflatus runs on\.$/));
    expect(useBanners.getState().items.find((b) => b.id === "check-ffmpeg")?.action).toBeUndefined();
  });

  it("follows a Get begun from the banner with About not open, and reads the checks again once it is done", async () => {
    sessionStorage.clear();
    fakeApi.on("GET /health", health([failed]));
    fakeApi.on("POST /ffmpeg/get", get({ phase: "downloading", bytes: 97 * 2 ** 20 }));
    fakeApi.on("GET /ffmpeg/get", get({ phase: "done", bytes: 194 * 2 ** 20 }));
    const Banner = () => (useMissingTools(), null);
    draw(<Banner />);
    await waitFor(() => expect(useBanners.getState().items.find((b) => b.id === "check-ffmpeg")?.action?.label).toBe("Get ffmpeg"));
    // nothing asked of Get ffmpeg before it is begun
    expect(fakeApi.calls("GET", "/ffmpeg/get")).toHaveLength(0);
    const reads = fakeApi.calls("GET", "/health").length;
    useBanners.getState().items.find((b) => b.id === "check-ffmpeg")!.action!.run();
    await waitFor(() => expect(fakeApi.calls("GET", "/ffmpeg/get").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(fakeApi.calls("GET", "/health").length).toBeGreaterThan(reads));
  });

  it("says it when the banner's Get ffmpeg is refused, in the server's words", async () => {
    sessionStorage.clear();
    fakeApi.on("GET /health", health([failed]));
    fakeApi.on("POST /ffmpeg/get", () => jsonAnswer({ error: "Get ffmpeg is done on the computer Afflatus runs on, not from another one." }, 403));
    const Banner = () => (useMissingTools(), null);
    draw(<Banner />);
    await waitFor(() => expect(useBanners.getState().items.find((b) => b.id === "check-ffmpeg")?.action?.label).toBe("Get ffmpeg"));
    useBanners.getState().items.find((b) => b.id === "check-ffmpeg")!.action!.run();
    await waitFor(() => expect(useBanners.getState().items.at(-1)).toMatchObject({ tone: "bad", title: "Get ffmpeg did not start", text: "Get ffmpeg is done on the computer Afflatus runs on, not from another one.", href: "/settings/about" }));
  });
});
