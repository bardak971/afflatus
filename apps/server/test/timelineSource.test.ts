import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import type { AssetRow } from "../src/timelineModel";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * A timeline's source lane: a long video made into Motion transfer clips window by window (timelineSource.ts). Rows put in
 * by hand; nothing is rendered and no file is read (no scene cuts asked for).
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw Object.assign(new Error(`${method} ${url}: ${res.statusCode} ${res.body}`), { statusCode: res.statusCode });
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();

async function asset(kind: "video" | "image", over: Partial<AssetRow> = {}): Promise<AssetRow> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind, origin: "uploaded", name: kind === "video" ? "meme.mp4" : "nicolas.png", file_key: `assets/${id.slice(0, 2)}/${id}`, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: 1000,
    width: 480, height: 854, duration_ms: kind === "video" ? 28000 : null, fps: kind === "video" ? 24 : null, has_sound: kind === "video" ? 1 : 0, folder_id: null, generation_id: null, kept_at: now(), ...over,
  })).execute();
  return t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

describe("a timeline's source lane", () => {
  it("is set by a video, its stretch and form kept, and taken away", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    let v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    expect(v.source).toMatchObject({ asset: meme.id, atMs: 0, fromMs: 0, toMs: 28000, windowMs: 5000 });
    expect(v.source.video.id).toBe(meme.id);
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs: { prompt: "A man raps." } } });
    expect(v.source).toMatchObject({ fromMs: 3000, toMs: 28000, recipe: "scail.motion", inputs: { prompt: "A man raps." } });
    // a stretch past the video's end is held within it
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { toMs: 99000 } });
    expect(v.source.toMs).toBe(28000);
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: null });
    expect(v.source).toBeNull();
    await expect(call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: (await asset("image")).id } })).rejects.toThrow(/video/);
  });

  it("is made into clips: one a window, each carrying on from the one before, the same picture, prompt and seed", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const picture = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs: { picture: picture.id, prompt: "A man raps.", seed: 42, steps: 8 } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    expect(made.clips).toHaveLength(5);
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(made.clips);
    expect(v.clips.map((c: { joined: string }) => c.joined)).toEqual(["cut", "continue", "continue", "continue", "continue"]);
    for (const c of v.clips) {
      expect(c.recipe).toBe("scail.motion");
      // the source's whole form in every window: its picture, prompt, seed and a setting changed in it
      expect(c.inputs).toMatchObject({ driving: { asset: meme.id }, picture: picture.id, prompt: "A man raps.", seed: 42, steps: 8 });
    }
    expect(v.clips[0].inputs.drivingStart).toBe(3);
    // the next part starts the carried frames (5 at 16 fps) before where the first one's clip stops
    expect(v.clips[1].inputs.drivingStart).toBeCloseTo(3 + 77 / 16 - 5 / 16, 3);
    // the source's start sits so that its stretch plays from where the clips start
    expect(v.source.atMs).toBe(-3000);
    // one step for Undo
    expect(v.undo).toMatch(/5 clips made from the source/);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(0);
  });

  it("makes a swap's windows on H3's grid, each carrying on from the one before", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test swap source" });
    const meme = await asset("video");
    const photo = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.swap", inputs: { who: "the man in the grey t-shirt", references: [{ asset: photo.id, role: "person" }] } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    // 25 s from 3 s: a 107-frame window opens, then 119 new frames each (141 with the 22 carried)
    expect(made.clips).toHaveLength(5);
    const v = await view(tl.id);
    expect(v.clips.map((c: { joined: string }) => c.joined)).toEqual(["cut", "continue", "continue", "continue", "continue"]);
    for (const c of v.clips) {
      expect(c.recipe).toBe("h3.swap");
      expect(c.inputs).toMatchObject({ source: { asset: meme.id }, who: "the man in the grey t-shirt" });
    }
    expect(v.clips[0].inputs.sourceStart).toBe(3);
    expect(v.clips[0].inputs.sourceSeconds).toBeCloseTo(107.5 / 24, 3);
    // the next part starts the 22 carried frames before where the first one's stretch stops
    expect(v.clips[1].inputs.sourceStart).toBeCloseTo(3 + 107 / 24 - 22 / 24, 3);
    expect(v.clips[1].inputs.sourceSeconds).toBeCloseTo(141.5 / 24, 3);
  });

  describe("a swap's clips share one form, the clip's (the owner, 2026-10-18)", () => {
    async function swapClips() {
      const tl = await call("POST", "/api/timelines", { name: "zz-test swap form" });
      const meme = await asset("video");
      const photo = await asset("image");
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.swap", inputs: { who: "the man", references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      const clips = (await view(tl.id)).clips as Array<{ id: string; inputs: Record<string, unknown> }>;
      const edit = (c: { id: string; inputs: Record<string, unknown> }, over: Record<string, unknown>, share?: string) =>
        call("PATCH", `/api/clips/${c.id}`, { inputs: { ...c.inputs, ...over }, ...(share ? { share } : {}) });
      return { tl, clips, edit, now: async () => (await view(tl.id)) as { clips: Array<{ id: string; inputs: Record<string, unknown> }>; source: { inputs: Record<string, unknown>; apart?: Record<string, string[]> } } };
    }

    it("a change on one clip is every clip's and the source's, but each window's part, run-up, seed and prompt", async () => {
      const { clips, edit, now } = await swapClips();
      await edit(clips[2]!, { who: "Swap the man in pink in <Video 1> with the character in <Picture 1>.", steps: 12, seed: 7, sourceStart: 99 });
      const v = await now();
      for (const c of v.clips) expect(c.inputs).toMatchObject({ steps: 12 });
      expect(v.source.inputs).toMatchObject({ steps: 12 });
      // the prompt is each clip's own (the owner, 2026-10-20: clip 6 can show something else than clip 2), and sets none apart
      expect(v.clips.map((c) => c.inputs.who)).toEqual(clips.map((c, k) => (k === 2 ? "Swap the man in pink in <Video 1> with the character in <Picture 1>." : c.inputs.who)));
      expect(v.source.inputs.who).toBe("the man");
      expect(v.source.apart).toBeUndefined();
      // the seed and the part of the source stay the clip's own
      expect(v.clips.filter((c) => c.inputs.seed === 7).map((c) => c.id)).toEqual([clips[2]!.id]);
      expect(v.clips[0]!.inputs.sourceStart).toBe(3);
    });

    it("a change kept to one clip sets it apart on that setting, and changes for all leave it alone there", async () => {
      const { clips, edit, now } = await swapClips();
      await edit(clips[2]!, { swapStrength: 1.2 }, "apart");
      let v = await now();
      expect(v.source.apart).toEqual({ [clips[2]!.id]: ["swapStrength"] });
      expect(v.clips.map((c) => c.inputs.swapStrength ?? 1)).toEqual([1, 1, 1.2, 1, 1]);
      // changed for all from another clip: every clip but the one set apart on it
      await edit(v.clips[0]!, { swapStrength: 0.9, steps: 10 });
      v = await now();
      expect(v.clips.map((c) => c.inputs.swapStrength)).toEqual([0.9, 0.9, 1.2, 0.9, 0.9]);
      expect(v.clips.every((c) => c.inputs.steps === 10)).toBe(true);
      // brought in line: the others' value, nothing kept apart
      await call("PATCH", `/api/clips/${clips[2]!.id}`, { share: "inLine" });
      v = await now();
      expect(v.clips[2]!.inputs.swapStrength).toBe(0.9);
      expect(v.source.apart).toBeUndefined();
    });

    it("is cut again when its window changes: the clips not rendered made anew with the form they share", async () => {
      const { tl, clips, edit, now } = await swapClips();
      await edit(clips[0]!, { who: "Swap the man in pink in <Video 1> with the character in <Picture 1>.", steps: 12 });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { windowMs: 3800, pick: { x: 0.4, y: 0.5 } } });
      const again = await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      const v = await now();
      expect(v.clips.map((c) => c.id)).toEqual(again.clips);
      expect(again.clips.length).toBeGreaterThan(clips.length);
      for (const c of v.clips) expect(c.inputs).toMatchObject({ who: "Swap the man in pink in <Video 1> with the character in <Picture 1>.", steps: 12 });
      expect(v.clips[0]!.inputs.source).toEqual(expect.objectContaining({ pick: { x: 0.4, y: 0.5 } }));
      expect(v.clips[0]!.inputs.sourceStart).toBe(3);
      expect((v as { undo?: string }).undo).toMatch(/cut again/);
    });

    it("cut again, keeps its rendered clips at the start and carries on from the last of them", async () => {
      const { tl, clips, now: read } = await swapClips();
      const video = await asset("video");
      await t.db.insertInto("takes").values({
        id: newId(), clip_id: clips[0]!.id, asset_id: video.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now(),
      } as never).execute();
      const take = await t.db.selectFrom("takes").select("id").where("clip_id", "=", clips[0]!.id).executeTakeFirstOrThrow();
      await t.db.updateTable("clips").set({ take_id: take.id }).where("id", "=", clips[0]!.id).execute();
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { windowMs: 3800 } });
      const again = await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      const v = await read();
      expect(v.clips[0]!.id).toBe(clips[0]!.id);
      expect(v.clips.slice(1).map((c) => c.id)).toEqual(again.clips);
      // the first new window starts 22 frames (its run-up) before where the kept one ends, carrying on from it
      const kept = clips[0]!.inputs as { sourceStart: number; sourceSeconds: number };
      const ends = kept.sourceStart + Math.floor(kept.sourceSeconds * 24 + 1e-6) / 24;
      expect(v.clips[1]!.inputs.sourceStart as number).toBeCloseTo(ends - 22 / 24, 3);
      expect((v.clips[1] as unknown as { joined: string }).joined).toBe("continue");
      // nothing left to cut once every clip is rendered
      for (const c of v.clips.slice(1)) await t.db.updateTable("clips").set({ take_id: take.id }).where("id", "=", c.id).execute();
      await expect(call("POST", `/api/timelines/${tl.id}/source/make`, { again: true })).rejects.toThrow(/nothing is left to cut again/);
    });

    it("a clip's prompt given to all: every clip and the source take it", async () => {
      const { clips, edit, now } = await swapClips();
      await edit(clips[1]!, { who: "Swap the man in pink in <Video 1> with the character in <Picture 1>." });
      await call("PATCH", `/api/clips/${clips[1]!.id}`, { share: "toAll" });
      const v = await now();
      expect(v.clips.every((c) => c.inputs.who === "Swap the man in pink in <Video 1> with the character in <Picture 1>.")).toBe(true);
      expect(v.source.inputs.who).toBe("Swap the man in pink in <Video 1> with the character in <Picture 1>.");
    });

    it("is cut again for the run-up set: every window carries on from that many frames, and none keeps another", async () => {
      const { tl, clips, edit, now } = await swapClips();
      const v0 = await now();
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { ...v0.source.inputs, context: "39" } } });
      const again = await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      let v = await now();
      expect(v.clips.map((c) => c.id)).toEqual(again.clips);
      expect(v.clips.every((c) => c.inputs.context === "39")).toBe(true);
      // each window that carries on starts 39 frames before where the one before ends
      for (let k = 1; k < v.clips.length; k++) {
        const p = v.clips[k - 1]!.inputs as { sourceStart: number; sourceSeconds: number };
        const ends = p.sourceStart + Math.floor(p.sourceSeconds * 24 + 1e-6) / 24;
        expect(v.clips[k]!.inputs.sourceStart as number).toBeCloseTo(ends - 39 / 24, 3);
      }
      // kept to one clip, the run-up still goes to all: a window carrying on from another count would not meet its part
      await edit(v.clips[1]!, { context: "5" }, "apart");
      v = await now();
      expect(v.clips.every((c) => c.inputs.context === "5")).toBe(true);
      expect(v.source.apart).toBeUndefined();
      expect(clips.length).toBeGreaterThan(1);
    });

    it("a clip's own settings given to all: every clip takes them, and none is set apart on them", async () => {
      const { clips, edit, now } = await swapClips();
      await edit(clips[1]!, { swapStrength: 1.3 }, "apart");
      await edit(clips[3]!, { swapStrength: 0.7 }, "apart");
      await call("PATCH", `/api/clips/${clips[1]!.id}`, { share: "toAll" });
      const v = await now();
      expect(v.clips.map((c) => c.inputs.swapStrength)).toEqual([1.3, 1.3, 1.3, 1.3, 1.3]);
      expect(v.source.apart).toBeUndefined();
      expect(v.source.inputs.swapStrength).toBe(1.3);
    });
  });

  it("makes Swap motion's windows: the first a swap with the source's prompt, those that carry on on the motion prompt", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test swap motion source" });
    const meme = await asset("video");
    const photo = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.swapMotion", inputs: { who: "Replace the woman in <Video 1> with the man in <Picture 1>.", references: [{ asset: photo.id, role: "person" }] } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    expect(made.clips).toHaveLength(5);
    const v = await view(tl.id);
    expect(v.clips[0].inputs.who).toBe("Replace the woman in <Video 1> with the man in <Picture 1>.");
    for (const c of v.clips.slice(1)) {
      expect(c.joined).toBe("continue");
      expect(c.inputs.who).not.toMatch(/<Video 1>/);
      expect(c.inputs.who).toMatch(/<Picture 1>/);
    }
    // the cast's picture is every window's
    for (const c of v.clips) expect(c.inputs.references).toEqual([{ asset: photo.id, role: "person" }]);
  });

  it("gives a swap's first window the person clicked on the stretch's first frame; a new start or video forgets the click", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test swap pick" });
    const meme = await asset("video");
    const photo = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    let v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.swap", pick: { x: 0.4, y: 0.45 }, inputs: { who: "the man", references: [{ asset: photo.id, role: "person" }] } } });
    expect(v.source.pick).toEqual({ x: 0.4, y: 0.45 });
    // kept through other changes
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { who: "the man in pink" } } });
    expect(v.source.pick).toEqual({ x: 0.4, y: 0.45 });
    await call("POST", `/api/timelines/${tl.id}/source/make`);
    const clips = (await view(tl.id)).clips;
    expect(clips[0].inputs.source).toEqual({ asset: meme.id, pick: { x: 0.4, y: 0.45 } });
    // the windows after follow the person the first replaced
    for (const c of clips.slice(1)) expect(c.inputs.source).toEqual({ asset: meme.id });
    // picked again once made (from a clip's Source chapter): the first window takes the new click, cleared it takes none
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: { x: 0.6, y: 0.5 } } });
    expect((await view(tl.id)).clips[0].inputs.source).toEqual({ asset: meme.id, pick: { x: 0.6, y: 0.5 } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: null } });
    expect((await view(tl.id)).clips[0].inputs.source).toEqual({ asset: meme.id });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: { x: 0.4, y: 0.45 } } });
    // another first frame: someone else's to pick
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 4000 } });
    expect(v.source.pick).toBeUndefined();
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: { x: 0.5, y: 0.5 } } });
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: null } });
    expect(v.source.pick).toBeUndefined();
    await expect(call("PATCH", `/api/timelines/${tl.id}`, { source: { pick: { x: 1.5, y: 0.5 } } })).rejects.toThrow(/400/);
  });

  it("takes the place of the clip its stretch was taken from", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const picture = await asset("image");
    const first = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: meme.id })).clip;
    const second = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: meme.id })).clip;
    // the second plays the meme from 3 s (trimmed), as a split there leaves it
    await call("PATCH", `/api/clips/${second}`, { trimStartMs: 3000 });
    const before = await view(tl.id);
    const c2 = before.clips[1];
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, atMs: c2.atMs - c2.take.startMs, fromMs: c2.take.startMs, toMs: c2.take.endMs, clip: second, recipe: "scail.motion", inputs: { picture: picture.id } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    const v = await view(tl.id);
    expect(v.clips[0].id).toBe(first);
    expect(v.clips.slice(1).map((c: { id: string }) => c.id)).toEqual(made.clips);
    expect(v.clips.some((c: { id: string }) => c.id === second)).toBe(false);
    expect(v.clips[1].inputs.drivingStart).toBe(3);
    // the source stays where it was laid, and no longer names the clip it replaced
    expect(v.source.atMs).toBe(c2.atMs - 3000);
    expect(v.source.clip).toBeNull();
  });

  it("is split at a moment: the part before plays as it is, a clip of its own, and Motion transfer starts there", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    const { clip } = await call("POST", `/api/timelines/${tl.id}/source/split`, { atMs: 3000 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([clip]);
    expect(v.clips[0].take).toMatchObject({ startMs: 0, endMs: 3000 });
    expect(v.source.fromMs).toBe(3000);
    expect(v.undo).toMatch(/source split/);
    await expect(call("POST", `/api/timelines/${tl.id}/source/split`, { atMs: 27900 })).rejects.toThrow(/stretch/);
  });

  it("snaps its windows to the scene cuts kept beside the source, not read again on each Make", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    // the cuts as the editor read them once (TimelineMedia.scenes): the file itself is never read here
    await t.services.storage.put(`scenes/${meme.id.slice(0, 2)}/${meme.id}.json`, new TextEncoder().encode(JSON.stringify({ cuts: [11000] })));
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, fromMs: 3000, snap: true, recipe: "scail.motion", inputs: { prompt: "A man raps." } } });
    await call("POST", `/api/timelines/${tl.id}/source/make`);
    const v = await view(tl.id);
    // a window ends on the cut, and the one after it opens a new shot
    const at = v.clips.findIndex((c: { joined: string }, i: number) => i > 0 && c.joined === "cut");
    expect(at).toBeGreaterThan(0);
    expect(Math.abs(v.clips[at].inputs.drivingStart - 11)).toBeLessThan(0.3);
  });

  it("is refused without a model that makes a source window by window, or without a source", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    await expect(call("POST", `/api/timelines/${tl.id}/source/make`)).rejects.toThrow(/Source lane/);
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, recipe: "h3.video" } });
    await expect(call("POST", `/api/timelines/${tl.id}/source/make`)).rejects.toThrow(/window by window/);
  });
});

describe("the windows of a source", () => {
  /** A source of the meme made into SCAIL windows from 3 s, with this form; the windows' ids. */
  async function made(tl: { id: string }, inputs: Record<string, unknown>): Promise<string[]> {
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs } });
    return (await call("POST", `/api/timelines/${tl.id}/source/make`)).clips as string[];
  }

  it("are given no seed of their own when none was typed: each render draws one, and the source's form stays random", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    await made(tl, { prompt: "A man raps.", seed: -1 });
    const v = await view(tl.id);
    // one seed drawn for every window was a typed seed to the seed mode: every New take was sent with it again
    for (const c of v.clips) expect(c.inputs.seed ?? -1).toBe(-1);
    expect(v.source.inputs.seed).toBe(-1);
  });

  it("share their prompt as their Picture: written on one, every window and the source take it; the seed and the part stay each one's", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, { prompt: "A man raps.", seed: 42 });
    const one = (await view(tl.id)).clips[1];
    await call("PATCH", `/api/clips/${ids[1]}`, { inputs: { ...one.inputs, prompt: "A woman sings.", seed: 7 } });
    let v = await view(tl.id);
    expect(v.clips.map((c: { inputs: { prompt: string } }) => c.inputs.prompt)).toEqual(ids.map(() => "A woman sings."));
    expect(v.source.inputs.prompt).toBe("A woman sings.");
    expect(v.clips.map((c: { inputs: { seed: number } }) => c.inputs.seed)).toEqual([42, 7, 42, 42, 42]);
    expect(new Set(v.clips.map((c: { inputs: { drivingStart: number } }) => c.inputs.drivingStart)).size).toBe(ids.length);
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { ...v.source.inputs, prompt: "A man dances." } } });
    v = await view(tl.id);
    expect(v.clips.every((c: { inputs: { prompt: string } }) => c.inputs.prompt === "A man dances.")).toBe(true);
  });

  it("made a cut, no longer start their carried frames early; made to carry on again, they do; a duplicate is a cut too", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, {});
    const before = (await view(tl.id)).clips[2].inputs;
    // SCAIL carries 5 frames at 16 fps: a cut makes the 4k + 1 that follow the 80 it shows, 81, ending where it ended
    await call("PATCH", `/api/clips/${ids[2]}`, { joined: "cut" });
    const cut = (await view(tl.id)).clips[2].inputs;
    expect(cut.drivingStart).toBeCloseTo(before.drivingStart + 4 / 16, 4);
    expect(cut.drivingSeconds).toBeCloseTo(81.5 / 16, 4);
    expect(cut.drivingStart + 81 / 16).toBeCloseTo(before.drivingStart + 85 / 16, 4);
    await call("PATCH", `/api/clips/${ids[2]}`, { joined: "continue" });
    const again = (await view(tl.id)).clips[2].inputs;
    expect(again.drivingStart).toBe(before.drivingStart);
    expect(again.drivingSeconds).toBe(before.drivingSeconds);
    await call("POST", `/api/clips/${ids[3]}/duplicate`);
    const v = await view(tl.id);
    expect(v.clips[4].joined).toBe("cut");
    expect(v.clips[4].inputs.drivingStart).toBeCloseTo(v.clips[3].inputs.drivingStart + 4 / 16, 4);
  });

  it("are not what a clip added after them is made with: it takes the timeline's other model, else none", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, {});
    const alone = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: ids[4] })).clip;
    expect((await view(tl.id)).clips.find((c: { id: string }) => c.id === alone).recipe).toBeNull();
    await call("POST", `/api/timelines/${tl.id}/clips`, { after: null, recipe: "h3.video" });
    const next = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: ids[2] })).clip;
    expect((await view(tl.id)).clips.find((c: { id: string }) => c.id === next).recipe).toBe("h3.video");
  });
  it("go with the source when it is taken away, rendered or not; one Undo brings back the source and its clips", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const before = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: null, recipe: "h3.video" })).clip;
    const ids = await made(tl, {});
    let v = await call("PATCH", `/api/timelines/${tl.id}`, { source: null });
    expect(v.source).toBeNull();
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([before]);
    expect(v.undo).toMatch(/the source and its 5 clips removed/);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    v = await view(tl.id);
    expect(v.source).not.toBeNull();
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([before, ...ids]);
  });

  it("are followed by a Cut when the clip added after them is of another model, and a clip switched to another model is cut on both sides", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { after: null, recipe: "h3.video" });
    const ids = await made(tl, {});
    const after = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: ids.at(-1) })).clip;
    const joinOf = async (id: string) => (await view(tl.id)).clips.find((c: { id: string }) => c.id === id).joined;
    expect(await joinOf(after)).toBe("cut");
    // a window in the middle switched to H3: it starts on its own, and the window after it no longer carries on from it
    await call("PATCH", `/api/clips/${ids[2]}`, { recipe: "h3.video" });
    expect(await joinOf(ids[2]!)).toBe("cut");
    expect(await joinOf(ids[3]!)).toBe("cut");
    // the same family carries on as it did: H3 after H3
    const third = (await call("POST", `/api/timelines/${tl.id}/clips`, { after })).clip;
    expect(await joinOf(third)).toBe("continue");
  });
});

describe("the Picture of a source's windows", () => {
  it("is one: changed on a window or on the source, every window and the source take it", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const first = await asset("image");
    const second = await asset("image");
    const third = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { recipe: "scail.motion", inputs: { picture: first.id } } });
    const made = (await call("POST", `/api/timelines/${tl.id}/source/make`)).clips as string[];
    const one = (await view(tl.id)).clips[2];
    await call("PATCH", `/api/clips/${made[2]}`, { inputs: { ...one.inputs, picture: second.id } });
    let v = await view(tl.id);
    expect(v.clips.map((c: { inputs: { picture: string } }) => c.inputs.picture)).toEqual(made.map(() => second.id));
    expect(v.source.inputs.picture).toBe(second.id);
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { ...v.source.inputs, picture: third.id } } });
    v = await view(tl.id);
    expect(v.clips.every((c: { inputs: { picture: string } }) => c.inputs.picture === third.id)).toBe(true);
  });
});

describe("a source saved while a Split runs", () => {
  it("keeps the start the Split gave it: the two take their turns", async () => {
    const tls = t.services.timelines;
    for (let ticks = 0; ticks < 4; ticks++) {
      const tl = await tls.create("zz-test split race");
      const meme = await asset("video");
      await tls.edit(tl.id, { source: { asset: meme.id } });
      const split = tls.splitSource(tl.id, 3000);
      for (let k = 0; k < ticks; k++) await new Promise((r) => setImmediate(r));
      await Promise.all([split, tls.edit(tl.id, { source: { windowMs: 6000 } })]);
      const v = await tls.view(tl.id);
      expect(v.source).toMatchObject({ fromMs: 3000, windowMs: 6000 });
    }
  });
});
