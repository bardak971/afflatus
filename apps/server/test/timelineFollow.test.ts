import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, makeApp, post, type TestApp } from "./helpers";

/** A timeline is listed in the folder its renders land in: moving all its takes into one folder takes it along. */
function makeClip(): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=192x320:rate=24:duration=1", "-pix_fmt", "yuv420p", file]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const clip = makeClip();

describe.skipIf(!clip)("timelines follow their takes into a folder", () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const upload = async (name: string) => (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip!) })).json();
  const folderOf = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json().folderId;

  it("moves a timeline whose takes all land in one folder, leaves one spread over two, and one whose folder was chosen", async () => {
    const orange = (await post(t.app, "/api/folders", { name: "Orange" })).json();
    const parrot = (await post(t.app, "/api/folders", { name: "Parrot" })).json();
    const a = await upload("a.mp4");
    const b = await upload("b.mp4");
    const c = await upload("c.mp4");
    const one = (await post(t.app, "/api/timelines", { name: "one" })).json();
    await post(t.app, `/api/timelines/${one.id}/clips`, { asset: a.id });
    await post(t.app, `/api/timelines/${one.id}/clips`, { asset: b.id });
    const spread = (await post(t.app, "/api/timelines", { name: "spread" })).json();
    await post(t.app, `/api/timelines/${spread.id}/clips`, { asset: c.id });
    await post(t.app, `/api/timelines/${spread.id}/clips`, { asset: a.id });
    const chosen = (await post(t.app, "/api/timelines", { name: "chosen" })).json();
    await post(t.app, `/api/timelines/${chosen.id}/clips`, { asset: b.id });
    await t.app.inject({ method: "PATCH", url: `/api/timelines/${chosen.id}`, payload: { folder: parrot.id } });

    const moved = (await post(t.app, "/api/assets/move", { ids: [a.id, b.id], folderId: orange.id })).json();
    // "one" has both its takes in Orange now; "spread" has one there and one outside; "chosen" keeps the folder it was given
    expect(await folderOf(one.id)).toBe(orange.id);
    expect(await folderOf(spread.id)).toBe(null);
    expect(await folderOf(chosen.id)).toBe(parrot.id);
    expect(moved.timelines).toBe(1);
  });
});
