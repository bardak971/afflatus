import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { rawFactsOf } from "../src/queueSubmit";
import { toolNeeds } from "../src/queueTools";
import type { Storage } from "../src/storage";
import { CUT_JOB } from "../src/timelineModel";
import { probeVideo } from "../src/video";
import { makeApp, type TestApp } from "./helpers";

/**
 * A take's kept frames (its raw side file) read once, in place, by ffprobe alone, in one cache the joins, the forecast and a
 * finish's needs share, kept to the last 256 files (card #119, U3 and P7).
 */

vi.mock("../src/video", async (real) => ({
  ...(await real<typeof import("../src/video")>()),
  probeVideo: vi.fn(async () => ({ facts: { width: 64, height: 64, fps: 24, durationMs: 1000, hasSound: false } })),
}));

/** A storage whose files are on this disk: read where they are, never loaded whole. */
const onDisk = (): Storage => ({ localPath: (key: string) => `/files/${key}`, get: vi.fn(async () => { throw new Error("loaded whole"); }) }) as unknown as Storage;

let t: TestApp;
beforeEach(async () => {
  vi.mocked(probeVideo).mockClear();
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe("a take's kept frames", () => {
  it("are read in place for a finish's needs, not loaded whole (U3)", async () => {
    const id = newId();
    // shown at 48 a second from the model's 24: interpolated, so its finish runs RIFE again
    await t.db.insertInto("assets").values(newAssetRow({
      id, kind: "video", origin: "generated", name: "zz-test take", file_key: `assets/${id}`, thumb_key: null, mime: "video/mp4", bytes: 1,
      width: 64, height: 64, duration_ms: 1000, fps: 48, has_sound: 0, folder_id: null, generation_id: null, kept_at: now(),
    })).execute();
    await t.db.updateTable("assets").set({ raw_key: `assets/${id}.raw` }).where("id", "=", id).execute();
    const storage = onDisk();
    const row = { recipe_id: CUT_JOB, inputs: JSON.stringify({ asset: id, startMs: 0, endMs: 1000, action: "finish", route: "seedvr" }) };
    expect(await toolNeeds({ db: t.db, storage }, row)).toMatchObject({ rife: true });
    expect(storage.get).not.toHaveBeenCalled();
    expect(probeVideo).toHaveBeenCalledWith(`/files/assets/${id}.raw`);
  });

  it("are kept for the last 256 files only (P7)", async () => {
    const storage = onDisk();
    for (let i = 0; i <= 256; i++) await rawFactsOf(storage, `zz-raw-${i}`, "video/mp4");
    expect(probeVideo).toHaveBeenCalledTimes(257);
    // the newest is kept; the oldest went, and is read again
    await rawFactsOf(storage, "zz-raw-256", "video/mp4");
    expect(probeVideo).toHaveBeenCalledTimes(257);
    await rawFactsOf(storage, "zz-raw-0", "video/mp4");
    expect(probeVideo).toHaveBeenCalledTimes(258);
  });
});
