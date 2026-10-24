import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { envSaid } from "./config";
import { gotDir } from "./ffmpegCheck";
import { fetchToFile, Refused } from "./modelDownload";
import { runProgram, systemTar } from "./updatesInstall";

/**
 * Get ffmpeg: the build the Windows and Linux bundles carry (scripts/release/bundle.mjs's FFMPEG_TAG, BtbN's GPL 9.0 build),
 * downloaded into the data folder's bin/ for an Afflatus run from the sources or with no usable ffmpeg found, its SHA-256
 * checked against the one written here, and used at once: the start-up check runs again and finds it there (ffmpegCheck.ts).
 * A test (ffmpegGet.test.ts) holds this in step with bundle.mjs and checksums.json.
 */
export const FFMPEG_BUILD = {
  tag: "autobuild-2026-09-30-13-08",
  files: {
    win32: { name: "ffmpeg-n9.0.2-17-g2a571b6068-win64-gpl-9.0.zip", sha256: "a0e45723c72141975f51d8666302e614711745f3102b704ca3f82c897a58d278", size: 194_034_585 },
    linux: { name: "ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz", sha256: "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269", size: 151_017_172 },
  },
} as const;

export type GetPhase = "idle" | "downloading" | "unpacking" | "checking" | "done" | "failed";

export interface GetView {
  phase: GetPhase;
  bytes: number;
  total: number;
  /** Why it failed, or what the check found wrong with the build it put there. */
  error: string | null;
}

const fileFor = (platform: NodeJS.Platform) => (platform === "win32" ? FFMPEG_BUILD.files.win32 : platform === "linux" ? FFMPEG_BUILD.files.linux : null);

/** One Get ffmpeg at a time; what it is doing, for the page that asked (Settings › About, the banner, the first launch). */
export class FfmpegGetter {
  view: GetView;
  private running: Promise<void> | null = null;

  /** `file`: another archive than BtbN's (the tests). */
  constructor(private o: { platform?: NodeJS.Platform; backoffMs?: number; file?: { name: string; sha256: string; size: number } } = {}) {
    // its size said before it starts: the page says what the button downloads
    this.view = { phase: "idle", bytes: 0, total: (o.file ?? fileFor(o.platform ?? process.platform))?.size ?? 0, error: null };
  }

  /**
   * Starts it, unless it is under way. `checked` runs the start-up check again once the files are in place and says what it
   * found wrong (null: the new ffmpeg passed and is used).
   */
  start(dataDir: string, checked: () => Promise<string | null>): GetView {
    if (this.running) return this.view;
    const file = this.o.file ?? fileFor(this.o.platform ?? process.platform);
    if (!file) throw new Refused("Get ffmpeg downloads the Windows and Linux builds only: on macOS, run brew install ffmpeg.");
    this.view = { phase: "downloading", bytes: 0, total: file.size, error: null };
    this.running = this.get(dataDir, file, checked)
      .catch((err: Error) => void (this.view = { ...this.view, phase: "failed", error: err.message }))
      .finally(() => void (this.running = null));
    return this.view;
  }

  /** Until the one under way ends (the tests). */
  async settled(): Promise<GetView> {
    await this.running;
    return this.view;
  }

  private async get(dataDir: string, file: { name: string; sha256: string; size: number }, checked: () => Promise<string | null>) {
    const win = (this.o.platform ?? process.platform) === "win32";
    const bin = gotDir(dataDir);
    const work = join(bin, ".get");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const own = envSaid.ffmpegGetUrl()?.trim();
      const source = `${own ? own.replace(/\/$/, "") : "https://github.com/BtbN/FFmpeg-Builds/releases/download"}/${FFMPEG_BUILD.tag}/${file.name}`;
      const archive = join(work, file.name);
      const got = await fetchToFile({
        source, headers: {}, allow: [own], dest: archive, signal: new AbortController().signal, backoffMs: this.o.backoffMs,
        onBytes: (bytes, total) => void (this.view = { ...this.view, bytes, total: total || file.size }),
      });
      if (got.sha256 !== file.sha256) throw new Refused(`The download's SHA-256 (${got.sha256.slice(0, 12)}…) is not the one of BtbN's build (${file.sha256.slice(0, 12)}…), so it was not used.`);
      this.view = { ...this.view, phase: "unpacking" };
      const into = join(work, "x");
      await mkdir(into);
      // run from the archive's folder with its bare name: Git's GNU tar reads "C:\…" as a remote host (updatesInstall.ts)
      const out = await runProgram(systemTar(), ["-xf", file.name, "-C", "x"], { cwd: work, timeoutMs: 10 * 60_000 });
      if (out.code !== 0) throw new Error(`The archive could not be unpacked (${out.said || `tar exited with ${out.code}`})`);
      const inner = (await readdir(into)).find((d) => d.startsWith("ffmpeg"));
      const from = inner ? join(into, inner) : into;
      for (const tool of ["ffmpeg", "ffprobe"]) {
        const name = win ? `${tool}.exe` : tool;
        const src = join(from, "bin", name);
        if (!existsSync(src)) throw new Error(`The archive holds no bin/${name}`);
        // beside it first, then in its place: an ffmpeg half copied is never the one found
        await copyFile(src, join(work, name));
        if (!win) await chmod(join(work, name), 0o755);
        await rm(join(bin, name), { force: true });
        await rename(join(work, name), join(bin, name));
      }
      if (existsSync(join(from, "LICENSE.txt"))) await copyFile(join(from, "LICENSE.txt"), join(bin, "LICENSE-ffmpeg.txt"));
      await writeFile(join(bin, "VERSIONS.txt"), `ffmpeg and ffprobe: BtbN FFmpeg-Builds ${FFMPEG_BUILD.tag}, ${file.name} (SHA-256 ${file.sha256}), put here by Get ffmpeg\n`);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
    this.view = { ...this.view, phase: "checking" };
    const wrong = await checked();
    this.view = { ...this.view, phase: wrong ? "failed" : "done", error: wrong };
  }
}

export const ffmpegGetter = new FfmpegGetter();
