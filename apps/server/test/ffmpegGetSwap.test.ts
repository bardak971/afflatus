import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The new file's rename into place failing for the name set here, as Windows says EBUSY for a file another program (an
 * antivirus scanning the new download) holds a moment. Putting the old one back is let through.
 */
const failing = { into: null as string | null };
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (from: string, to: string) => {
    if (failing.into && basename(to) === failing.into && !from.endsWith(".old")) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: "EBUSY" });
    return real.rename(from, to);
  };
  return { ...real, rename, default: { ...real, rename } };
});

const { swapIn } = await import("../src/ffmpegGet");

const root = mkdtempSync(join(tmpdir(), "afflatus-ffswap-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A data folder's bin/ with the old pair, and the Get's work folder with the new one. */
function pair(name: string) {
  const bin = join(root, name, "bin");
  const work = join(bin, ".get");
  mkdirSync(work, { recursive: true });
  for (const t of ["ffmpeg", "ffprobe"]) {
    writeFileSync(join(bin, t), `old ${t}`);
    writeFileSync(join(work, t), `new ${t}`);
  }
  return { bin, work, read: () => ["ffmpeg", "ffprobe"].map((t) => readFileSync(join(bin, t), "utf8")) };
}

describe("Get ffmpeg puts its pair in place", () => {
  it("both together", async () => {
    const p = pair("both");
    await swapIn(p.work, p.bin, ["ffmpeg", "ffprobe"]);
    expect(p.read()).toEqual(["new ffmpeg", "new ffprobe"]);
  });

  it("or neither: ffprobe's rename failing leaves the old ffmpeg with the old ffprobe, not the new ffmpeg with it", async () => {
    const p = pair("busy");
    failing.into = "ffprobe";
    try {
      await expect(swapIn(p.work, p.bin, ["ffmpeg", "ffprobe"])).rejects.toThrow(/EBUSY/);
    } finally {
      failing.into = null;
    }
    expect(p.read()).toEqual(["old ffmpeg", "old ffprobe"]);
    expect(readdirSync(p.bin).sort()).toEqual([".get", "ffmpeg", "ffprobe"]);
  });

  it("with nothing there before", async () => {
    const bin = join(root, "none", "bin");
    const work = join(bin, ".get");
    mkdirSync(work, { recursive: true });
    for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(work, t), `new ${t}`);
    await swapIn(work, bin, ["ffmpeg", "ffprobe"]);
    expect(readFileSync(join(bin, "ffprobe"), "utf8")).toBe("new ffprobe");
  });
});
