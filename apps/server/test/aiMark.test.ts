import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { AI_COMMENT, AI_SOURCE_TYPE, markPng } from "../src/aiMark";
import { markedVideoFile } from "../src/cut";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, makeApp } from "./helpers";
import { frames, timelineSteps, timelineSuite } from "./timelineKit";

/** What leaves Afflatus from a render says it was made by a model (aiMark.ts); what the user brought in never does. */

/** The comment in a video's container, read by ffprobe. */
function commentOf(bytes: Uint8Array, ext = "mp4"): string {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-mark-"));
  const file = join(dir, `v.${ext}`);
  writeFileSync(file, bytes);
  const out = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return out.stdout.trim();
}

const picture = () => sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 200, g: 40, b: 10 } } }).png().toBuffer();

describe("a PNG marked", () => {
  it("carries the IPTC digital source type and a comment, its pixels the same, and is marked once", async () => {
    const png = await picture();
    const marked = Buffer.from(markPng(png));
    expect(marked.toString("utf8")).toContain(AI_SOURCE_TYPE);
    expect(marked.toString("latin1")).toContain(`Comment\0${AI_COMMENT}`);
    // the picture itself is untouched, and the file still reads as a PNG
    expect(await sharp(marked).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    expect(Buffer.from(markPng(marked)).equals(marked)).toBe(true);
    // what is not a PNG comes back as it was
    const jpeg = await sharp(png).jpeg().toBuffer();
    expect(Buffer.from(markPng(jpeg)).equals(jpeg)).toBe(true);
  });
});

describe("a picture downloaded from the library", () => {
  it("is marked when it is a render or a copy of one, never when the user brought it in", async () => {
    const t = await makeApp();
    try {
      const upload = async (name: string) => (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "image/png" }, payload: await picture() })).json() as { id: string };
      const file = async (id: string, download = true) => (await get(t.app, `/api/assets/${id}/file${download ? "?download=1" : ""}`)).rawPayload;
      const own = await upload("photo");
      const made = await upload("render");
      await t.db.updateTable("assets").set({ origin: "generated" }).where("id", "=", made.id).execute();

      expect((await file(own.id)).toString("latin1")).not.toContain(AI_COMMENT);
      expect((await file(made.id)).toString("latin1")).toContain(AI_COMMENT);
      // played or shown in the app: the library's file as it is
      expect((await file(made.id, false)).toString("latin1")).not.toContain(AI_COMMENT);

      // a mirrored copy follows what it was made from
      const mirror = async (id: string) => (await t.app.inject({ method: "POST", url: `/api/assets/${id}/mirror`, payload: { axis: "horizontal" } })).json() as { id: string };
      expect((await file((await mirror(made.id)).id)).toString("latin1")).toContain(AI_COMMENT);
      expect((await file((await mirror(own.id)).id)).toString("latin1")).not.toContain(AI_COMMENT);
    } finally {
      await t.close();
    }
  });
});

const s = timelineSuite();
const { call, view, twoClips, exported } = timelineSteps(s);

describe.skipIf(!ffmpegThere)("a video leaving Afflatus", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is marked when downloaded as a render, its frames the same", async () => {
    const { id } = await twoClips();
    const take = (await view(id)).clips[0].take.asset.id as string;
    const raw = (await get(s.t.app, `/api/assets/${take}/file`)).rawPayload;
    const answer = await get(s.t.app, `/api/assets/${take}/file?download=1`);
    const down = answer.rawPayload;
    expect(commentOf(raw)).not.toBe(AI_COMMENT);
    expect(commentOf(down)).toBe(AI_COMMENT);
    expect(frames(down)).toBe(frames(raw));
    // streamed from the marked copy on the disk, its length said before the first byte
    expect(Number(answer.headers["content-length"])).toBe(down.length);
  });

  it("is marked in a temporary file that is removed once read", async () => {
    const { id } = await twoClips();
    const take = (await view(id)).clips[0].take.asset.id as string;
    const raw = (await get(s.t.app, `/api/assets/${take}/file`)).rawPayload;
    const marked = await markedVideoFile(new Uint8Array(raw), "mp4");
    expect(statSync(marked.file).size).toBe(marked.size);
    expect(commentOf(readFileSync(marked.file))).toBe(AI_COMMENT);
    await marked.done();
    expect(existsSync(dirname(marked.file))).toBe(false);
  });

  it("marks an export that holds a render, and not one made only of what the user brought in", async () => {
    const { id } = await twoClips();
    const out = await exported(id);
    expect(commentOf((await get(s.t.app, `/api/assets/${out.id}/file`)).rawPayload)).toBe(AI_COMMENT);
    // the same clips as if they were the user's own films
    await s.t.db.updateTable("assets").set({ origin: "uploaded" }).where("origin", "=", "generated").execute();
    await call("PATCH", `/api/timelines/${id}`, { name: "Evening again" });
    const own = await exported(id);
    expect(commentOf((await get(s.t.app, `/api/assets/${own.id}/file`)).rawPayload)).toBe("");
  });

  it("marks the renders in the zip for a video editor", async () => {
    const { id } = await twoClips();
    const zip = (await s.t.app.inject({ method: "GET", url: `/api/timelines/${id}/project.zip` })).rawPayload;
    // a file is stored in the zip as it is, its comment readable in it
    expect(zip.toString("latin1").split(AI_COMMENT).length - 1).toBeGreaterThanOrEqual(2);
  });
});
