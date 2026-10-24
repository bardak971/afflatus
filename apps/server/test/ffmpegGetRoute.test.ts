import { afterEach, describe, expect, it, vi } from "vitest";
import { ffmpegGetter } from "../src/ffmpegGet";
import { preflight } from "../src/preflight";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp | null = null;
const before = preflight.last;
afterEach(async () => {
  await t?.close();
  t = null;
  preflight.last = before;
  vi.restoreAllMocks();
});

/** A start-up check whose ffmpeg passed, or failed, as the route reads it. */
function lastCheck(ok: boolean) {
  const used = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", where: "path" as const, ok, version: ok ? "9.0.2" : "7.1", probeVersion: null, why: ok ? null : "cut 21 frames where 22 were asked (at 24 fps)" };
  preflight.last = { at: new Date().toISOString(), checks: [], ok, ffmpeg: { used, refused: [], pinned: false } };
}

describe("POST /api/ffmpeg/get", () => {
  it("is refused from another computer, as Updates are, and nothing is downloaded", async () => {
    t = await makeApp();
    lastCheck(false);
    const start = vi.spyOn(ffmpegGetter, "start").mockReturnValue(ffmpegGetter.view);
    for (const from of [{ remoteAddress: "192.168.1.20" }, { headers: { "x-forwarded-for": "203.0.113.9" } }]) {
      const res = await t.app.inject({ method: "POST", url: "/api/ffmpeg/get", ...from });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/computer Afflatus runs on/);
    }
    expect(start).not.toHaveBeenCalled();
    expect((await t.app.inject({ method: "POST", url: "/api/ffmpeg/get" })).statusCode).toBe(200);
    expect(start).toHaveBeenCalledOnce();
  });

  it("is refused in the Docker image, whose own ffmpeg is the one it uses (card #75)", async () => {
    t = await makeApp();
    lastCheck(false);
    vi.stubEnv("AFFLATUS_INSTALL", "docker");
    try {
      const start = vi.spyOn(ffmpegGetter, "start").mockReturnValue(ffmpegGetter.view);
      const res = await t.app.inject({ method: "POST", url: "/api/ffmpeg/get" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/uses the image's ffmpeg/);
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is refused when the ffmpeg in use passed the checks", async () => {
    t = await makeApp();
    lastCheck(true);
    const start = vi.spyOn(ffmpegGetter, "start").mockReturnValue(ffmpegGetter.view);
    const res = await t.app.inject({ method: "POST", url: "/api/ffmpeg/get" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ffmpeg 9\.0\.2 \(PATH\) passed the checks/);
    expect(start).not.toHaveBeenCalled();
  });
});
