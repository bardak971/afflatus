import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eachAtMost } from "../src/measures-api";
import { get, makeApp, post, type TestApp } from "./helpers";

/** A two-second test clip with a tone, made with ffmpeg. These tests are skipped where ffmpeg is not installed. */
function makeClip(): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=192x320:rate=16:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const clip = makeClip();

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const upload = async (name: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip!) })).json() as { id: string };

describe("several at once, a few at a time", () => {
  it("answers every id once, the failed ones null, never more at once than asked", async () => {
    let now = 0;
    let most = 0;
    const got = await eachAtMost(["a", "b", "a", "bad", "c", "d"], 2, async (id) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      if (id === "bad") throw new Error("no");
      return id.toUpperCase();
    });
    expect(got).toEqual({ a: "A", b: "B", bad: null, c: "C", d: "D" });
    expect(most).toBe(2);
  });
});

describe.skipIf(!clip)("the timeline editor's measures, asked for together", () => {
  it("gives the motion of several videos in one request, as each one's own route does", async () => {
    const one = await upload("one.mp4");
    const two = await upload("two.mp4");
    const res = await post(t.app, "/api/measures/motion", { ids: [one.id, two.id, "nothing-here"] });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Record<string, { rate: number; values: number[] } | null>;
    expect(items[one.id]).toEqual((await get(t.app, `/api/assets/${one.id}/motion`)).json());
    expect(items[two.id]!.rate).toBe(10);
    expect(items["nothing-here"]).toBeNull();
  });

  it("gives the joins of several clips in one request", async () => {
    const one = await upload("one.mp4");
    const two = await upload("two.mp4");
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test joins" })).json() as { id: string };
    const a = (await post(t.app, `/api/timelines/${tl.id}/clips`, { asset: one.id })).json().clip as string;
    const b = (await post(t.app, `/api/timelines/${tl.id}/clips`, { asset: two.id })).json().clip as string;
    const items = (await post(t.app, "/api/measures/joins", { ids: [a, b, "no-clip"] })).json().items as Record<string, Array<{ take: string; in: number | null; out: number | null }> | null>;
    expect(items[a]).toEqual((await get(t.app, `/api/clips/${a}/joins`)).json().items);
    expect(items[b]).toEqual((await get(t.app, `/api/clips/${b}/joins`)).json().items);
    expect(typeof items[a]![0]!.out).toBe("number");
    expect(typeof items[b]![0]!.in).toBe("number");
    expect(items["no-clip"]).toBeNull();
  });

  it("refuses a list that is not one", async () => {
    expect((await post(t.app, "/api/measures/motion", { ids: "x" })).statusCode).toBe(400);
    expect((await post(t.app, "/api/measures/joins", { ids: Array.from({ length: 201 }, (_, i) => `c${i}`) })).statusCode).toBe(400);
  });
});
