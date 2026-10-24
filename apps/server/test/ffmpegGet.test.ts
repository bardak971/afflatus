import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_BUILD, FfmpegGetter } from "../src/ffmpegGet";
import { systemTar } from "../src/updatesInstall";

const win = process.platform === "win32";
const exe = win ? ".exe" : "";
const root = mkdtempSync(join(tmpdir(), "afflatus-ffget-"));
let server: Server;
let archive: { name: string; sha256: string; size: number };
const served: string[] = [];

beforeAll(async () => {
  // an archive laid out as BtbN's: ffmpeg-<build>/bin/{ffmpeg,ffprobe}, LICENSE.txt
  const top = join(root, "pack", "ffmpeg-n9.0.2-test");
  mkdirSync(join(top, "bin"), { recursive: true });
  for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(top, "bin", t + exe), `${t} stand-in`);
  writeFileSync(join(top, "LICENSE.txt"), "GPL");
  const name = win ? "ffmpeg-test-win64-gpl-9.0.zip" : "ffmpeg-test-linux64-gpl-9.0.tar.gz";
  execFileSync(systemTar(), [win ? "-a" : "-z", "-cf", name, "-C", "pack", "ffmpeg-n9.0.2-test"], { cwd: root });
  const bytes = readFileSync(join(root, name));
  archive = { name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  server = createServer((req, res) => {
    served.push(req.url ?? "");
    if (req.url?.endsWith(`/${name}`)) res.end(bytes);
    else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.FFMPEG_GET_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.FFMPEG_GET_URL;
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
});

describe("Get ffmpeg", () => {
  it("puts the build's ffmpeg and ffprobe in the data folder's bin, then checks again", async () => {
    const data = join(root, "data");
    let checks = 0;
    const getter = new FfmpegGetter({ file: archive });
    expect(getter.start(data, async () => (checks++, null)).phase).toBe("downloading");
    const view = await getter.settled();
    expect(view).toMatchObject({ phase: "done", error: null, bytes: archive.size });
    expect(checks).toBe(1);
    expect(served).toContain(`/${FFMPEG_BUILD.tag}/${archive.name}`);
    for (const t of ["ffmpeg", "ffprobe"]) expect(readFileSync(join(data, "bin", t + exe), "utf8")).toBe(`${t} stand-in`);
    expect(readFileSync(join(data, "bin", "LICENSE-ffmpeg.txt"), "utf8")).toBe("GPL");
    expect(readFileSync(join(data, "bin", "VERSIONS.txt"), "utf8")).toMatch(new RegExp(archive.sha256));
    // nothing of the download left beside it
    expect(existsSync(join(data, "bin", ".get"))).toBe(false);
  });

  it("refuses a download whose SHA-256 is not the build's, and puts nothing in place", async () => {
    const data = join(root, "data-bad");
    const getter = new FfmpegGetter({ file: { ...archive, sha256: "0".repeat(64) } });
    getter.start(data, async () => null);
    const view = await getter.settled();
    expect(view.phase).toBe("failed");
    expect(view.error).toMatch(/SHA-256 .* is not the one of BtbN's build/);
    expect(existsSync(join(data, "bin", "ffmpeg" + exe))).toBe(false);
  });

  it("says what the check found when the new ffmpeg does not pass", async () => {
    const getter = new FfmpegGetter({ file: archive });
    getter.start(join(root, "data-wrong"), async () => "9.0.2 (Get ffmpeg's) has no libx264 encoder");
    expect(await getter.settled()).toMatchObject({ phase: "failed", error: "9.0.2 (Get ffmpeg's) has no libx264 encoder" });
  });

  it("downloads nothing on macOS: Homebrew's line is said instead", () => {
    expect(() => new FfmpegGetter({ platform: "darwin" }).start(join(root, "data-mac"), async () => null)).toThrow(/brew install ffmpeg/);
  });

  it("is the build the bundles carry: bundle.mjs's tag and checksums.json's sums, the GPL one (with libx264)", () => {
    const here = resolve(__dirname, "../../../scripts/release");
    expect(readFileSync(join(here, "bundle.mjs"), "utf8")).toContain(`const FFMPEG_TAG = "${FFMPEG_BUILD.tag}";`);
    const sums = JSON.parse(readFileSync(join(here, "checksums.json"), "utf8")) as { sha256: Record<string, string> };
    for (const f of Object.values(FFMPEG_BUILD.files)) {
      expect(f.name).toMatch(/-gpl-9\.0\./);
      expect(sums.sha256[f.name]).toBe(f.sha256);
    }
  });

  it("is the build the Docker image carries on amd64: the Dockerfile's tag, archive and sum", () => {
    const docker = readFileSync(resolve(__dirname, "../../../Dockerfile"), "utf8");
    expect(docker).toContain(`tag=${FFMPEG_BUILD.tag};`);
    expect(docker).toContain(`amd64) file=${FFMPEG_BUILD.files.linux.name}; sum=${FFMPEG_BUILD.files.linux.sha256} ;;`);
    // Debian's ffmpeg is below the minimum (bookworm's 5.1) or miscounts a join's run-up (trixie's 7.1)
    expect(docker).not.toMatch(/apt-get install[^\n]*\bffmpeg\b/);
  });

  it("holds the Dockerfile's sums, arm64's too, to checksums.json: nothing else checks the arm64 one", () => {
    const docker = readFileSync(resolve(__dirname, "../../../Dockerfile"), "utf8");
    const sums = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/release/checksums.json"), "utf8")) as { sha256: Record<string, string> };
    const listed = [...docker.matchAll(/^\s*(\w+)\) file=(\S+); sum=([0-9a-f]{64}) ;;/gm)].map((m) => ({ arch: m[1], file: m[2]!, sum: m[3] }));
    expect(listed.map((l) => l.arch)).toEqual(["amd64", "arm64"]);
    for (const l of listed) {
      expect(l.file).toMatch(/-gpl-9\.0\.tar\.xz$/);
      expect(sums.sha256[l.file], l.file).toBe(l.sum);
    }
  });
});
