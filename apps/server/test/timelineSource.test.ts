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

  it("makes a swap's windows on H3's grid, each carrying on from the one before: a swap where a shot opens, Motion transfer after it", async () => {
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
    // the person replaced is never in a window that carries on (card #42: what H3 · Swap motion did by itself)
    expect(v.clips.map((c: { recipe: string }) => c.recipe)).toEqual(["h3.swap", "h3.motion", "h3.motion", "h3.motion", "h3.motion"]);
    for (const c of v.clips) expect(c.inputs).toMatchObject({ source: { asset: meme.id }, references: [{ asset: photo.id, role: "person" }] });
    expect(v.clips[0].inputs.who).toBe("the man in the grey t-shirt");
    // a motion window after a swap: no Picture of its own, the swap's shifts (it runs on the swap's model)
    for (const c of v.clips.slice(1)) {
      expect(c.inputs.picture).toBeUndefined();
      expect(c.inputs).toMatchObject({ afterSwap: true, shiftVideo: 12, shiftAudio: 3 });
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
      // every window a swap (the source's form given to all of them): Make alone makes the ones that carry on Motion transfer
      await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "h3.swap" });
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

    it("cut again for an empty clip after its rendered clips (the last one removed), makes the next window in that clip's place", async () => {
      const { tl, clips, now: read } = await swapClips();
      const video = await asset("video");
      // every window rendered but the last, which is removed; an empty clip added after them
      const rendered = clips.slice(0, -1);
      for (const c of rendered) {
        const take = newId();
        await t.db.insertInto("takes").values({
          id: take, clip_id: c.id, asset_id: video.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now(),
        } as never).execute();
        await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", c.id).execute();
      }
      await call("DELETE", `/api/clips/${clips.at(-1)!.id}`);
      const added = await call("POST", `/api/timelines/${tl.id}/clips`, {});
      const emptyId = (added.id ?? (await read()).clips.at(-1)!.id) as string;
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { recipe: "h3.swap", clip: emptyId } });
      const again = await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      const v = await read();
      expect(v.clips.map((c) => c.id)).not.toContain(emptyId);
      expect(v.clips.slice(0, rendered.length).map((c) => c.id)).toEqual(rendered.map((c) => c.id));
      expect(v.clips.slice(rendered.length).map((c) => c.id)).toEqual(again.clips);
      // it carries on from the last rendered window, its run-up before where that one ends
      const last = rendered.at(-1)!.inputs as { sourceStart: number; sourceSeconds: number };
      const ends = last.sourceStart + Math.floor(last.sourceSeconds * 24 + 1e-6) / 24;
      expect(v.clips[rendered.length]!.inputs.sourceStart as number).toBeCloseTo(ends - 22 / 24, 3);
      expect((v.clips[rendered.length] as unknown as { joined: string }).joined).toBe("continue");
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

  describe("a form per window (card #42: H3 · Swap motion retired)", () => {
    const WHO = "Replace the woman in <Video 1> with the man in <Picture 1>.";
    const mixed = async (name: string) => {
      const tl = await call("POST", "/api/timelines", { name });
      const meme = await asset("video");
      const photo = await asset("image");
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.swap", inputs: { who: WHO, references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      return { tl, meme, photo, v: await view(tl.id) };
    };
    const recipes = (v: { clips: Array<{ recipe: string }> }) => v.clips.map((c) => c.recipe);

    it("shares the source's parts with every window whatever its form; What happens stays each window's own", async () => {
      const { tl, photo, v } = await mixed("zz-test mixed share");
      expect(recipes(v)).toEqual(["h3.swap", "h3.motion", "h3.motion", "h3.motion", "h3.motion"]);
      const other = await asset("image");
      // How they look and the references, changed on a motion window: the swap's too, and the source's form
      await call("PATCH", `/api/clips/${v.clips[2].id}`, { inputs: { ...v.clips[2].inputs, look: "a white shirt", references: [{ asset: other.id, role: "person" }], happens: "he waves" } });
      let now = await view(tl.id);
      for (const c of now.clips) expect(c.inputs).toMatchObject({ look: "a white shirt", references: [{ asset: other.id, role: "person" }] });
      expect(now.source.inputs).toMatchObject({ look: "a white shirt" });
      expect(now.clips.map((c: { inputs: { happens?: string } }) => c.inputs.happens ?? "")).toEqual(["", "", "he waves", "", ""]);
      // a setting of the swap's alone, changed on window 1: kept on the motion windows too, unread (it comes back with the form)
      await call("PATCH", `/api/clips/${now.clips[0].id}`, { inputs: { ...now.clips[0].inputs, swapStrength: 1.3 } });
      now = await view(tl.id);
      for (const c of now.clips) expect(c.inputs.swapStrength).toBe(1.3);
      // the motion's own setting, changed on one motion window: every motion window's
      await call("PATCH", `/api/clips/${now.clips[1].id}`, { inputs: { ...now.clips[1].inputs, controlStrength: 0.8 } });
      now = await view(tl.id);
      for (const c of now.clips.slice(1)) expect(c.inputs.controlStrength).toBe(0.8);
      expect(photo.id).not.toBe(other.id);
    });

    it("gives one window another form of its grid in place: its part, its takes and the other windows kept, one Undo step", async () => {
      const { tl, v } = await mixed("zz-test window form");
      const video = await asset("video");
      const take = newId();
      await t.db.insertInto("takes").values({ id: take, clip_id: v.clips[2].id, asset_id: video.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() }).execute();
      await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", v.clips[2].id).execute();
      // a swap again where the motion drifts, the motion windows after it carrying on from it
      await call("POST", `/api/timelines/${tl.id}/source/window`, { clip: v.clips[2].id, recipe: "h3.swap" });
      const after = await view(tl.id);
      expect(recipes(after)).toEqual(["h3.swap", "h3.motion", "h3.swap", "h3.motion", "h3.motion"]);
      expect(after.clips.map((c: { id: string }) => c.id)).toEqual(v.clips.map((c: { id: string }) => c.id));
      expect(after.clips[2].take?.id).toBe(take);
      expect(after.clips[2].inputs.sourceStart).toBe(v.clips[2].inputs.sourceStart);
      expect(after.clips[2].joined).toBe("continue");
      expect(after.source.recipe).toBe("h3.swap");
      // a window made a swap again keeps the swap's prompt it was given
      expect(after.clips[2].inputs.who).toBe(WHO);
      await call("POST", `/api/timelines/${tl.id}/undo`);
      expect(recipes(await view(tl.id))).toEqual(["h3.swap", "h3.motion", "h3.motion", "h3.motion", "h3.motion"]);
      // and the opening window made Motion transfer: it then needs a Picture of its own, as any Motion transfer that opens
      await call("POST", `/api/timelines/${tl.id}/source/window`, { clip: v.clips[0].id, recipe: "h3.motion" });
      expect(recipes(await view(tl.id))[0]).toBe("h3.motion");
    });

    it("refuses a form of another grid for one window, and one that renders", async () => {
      const { tl, v } = await mixed("zz-test window form refused");
      await expect(call("POST", `/api/timelines/${tl.id}/source/window`, { clip: v.clips[1].id, recipe: "scail.motion" })).rejects.toThrow(/give it to all/);
      await t.db.insertInto("jobs").values({ id: newId(), owner_id: "local", recipe_id: "h3.motion", label: "x", inputs: "{}", status: "running", priority: 0, clip_id: v.clips[1].id, created_at: now(), updated_at: now() } as never).execute();
      await expect(call("POST", `/api/timelines/${tl.id}/source/window`, { clip: v.clips[1].id, recipe: "h3.swap" })).rejects.toMatchObject({ statusCode: 409 });
    });

    it("dropped for an empty clip of Swap character, makes its windows in that clip's place", async () => {
      const tl = await call("POST", "/api/timelines", { name: "zz-test swap drop" });
      const meme = await asset("video");
      const empty = await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.swap" });
      const emptyId = (empty.id ?? empty.clip?.id ?? (await view(tl.id)).clips[0].id) as string;
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, recipe: "h3.swap", clip: emptyId } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, inputs: { who: WHO } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      const v = await view(tl.id);
      expect(v.clips.map((c: { id: string }) => c.id)).not.toContain(emptyId);
      expect(recipes(v)[0]).toBe("h3.swap");
      expect(recipes(v).slice(1).every((r: string) => r === "h3.motion")).toBe(true);
    });

    it("is made again with Swap character after Motion transfer: the openings swaps, the rest Motion transfer", async () => {
      const tl = await call("POST", "/api/timelines", { name: "zz-test motion to swap" });
      const meme = await asset("video");
      const photo = await asset("image");
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "h3.motion", inputs: { picture: photo.id, references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      expect(recipes(await view(tl.id)).every((r) => r === "h3.motion")).toBe(true);
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { recipe: "h3.swap", inputs: { who: WHO, references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      const v = await view(tl.id);
      expect(recipes(v)[0]).toBe("h3.swap");
      expect(recipes(v).slice(1).every((r: string) => r === "h3.motion")).toBe(true);
      // the motion windows after the swap have no Picture: they carry on from it, on the swap's model
      for (const c of v.clips.slice(1)) expect(c.inputs.picture).toBeUndefined();
      for (const c of v.clips) expect(c.inputs.references).toEqual([{ asset: photo.id, role: "person" }]);
    });
  });

  describe("given another form after Make (Timelines.sourceForm)", () => {
    const WHO = "Replace the woman in <Video 1> with the man in <Picture 1>.";
    const madeWith = async (recipe: string) => {
      const tl = await call("POST", "/api/timelines", { name: `zz-test source form ${recipe}` });
      const meme = await asset("video");
      const photo = await asset("image");
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, toMs: 18000, recipe, inputs: { who: WHO, prompt: "A man dances.", picture: photo.id, references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      return { tl, meme, photo, v: await view(tl.id) };
    };
    const takeFor = async (clipId: string, videoId: string) => {
      const take = newId();
      await t.db.insertInto("takes").values({
        id: take, clip_id: clipId, asset_id: videoId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now(),
      }).execute();
      await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clipId).execute();
      return take;
    };

    it("between H3 forms (one grid): in place, its windows, their parts and their takes kept", async () => {
      const { tl, meme, v } = await madeWith("h3.swap");
      const before = v.clips.map((c: { id: string; inputs: Record<string, unknown> }) => ({ id: c.id, start: c.inputs.sourceStart, seconds: c.inputs.sourceSeconds }));
      const take = await takeFor(v.clips[0].id, (await asset("video")).id);
      const r = await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "h3.motion" });
      expect(r).toEqual({ switched: true, clips: [] });
      const after = await view(tl.id);
      expect(after.source.recipe).toBe("h3.motion");
      expect(after.clips.map((c: { id: string }) => c.id)).toEqual(before.map((b: { id: string }) => b.id));
      expect(after.clips.every((c: { recipe: string }) => c.recipe === "h3.motion")).toBe(true);
      // each window's part as it was: Motion transfer reads it by the swap's own inputs
      after.clips.forEach((c: { inputs: Record<string, unknown> }, k: number) => {
        expect(c.inputs.source).toMatchObject({ asset: meme.id });
        expect([c.inputs.sourceStart, c.inputs.sourceSeconds]).toEqual([before[k]!.start, before[k]!.seconds]);
      });
      expect(after.clips[0].take?.id).toBe(take);
      // one step: Undo brings the windows back as they were, a swap opening and Motion transfer after it
      await call("POST", `/api/timelines/${tl.id}/undo`);
      expect((await view(tl.id)).clips.map((c: { recipe: string }) => c.recipe)).toEqual(v.clips.map((c: { recipe: string }) => c.recipe));
      expect(v.clips[0].recipe).toBe("h3.swap");
    });

    it("given to all its windows, whatever form each had: every one a swap, the prompt each was given kept", async () => {
      const { tl } = await madeWith("h3.swap");
      await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "h3.swap" });
      const v = await view(tl.id);
      expect(v.clips.every((c: { recipe: string }) => c.recipe === "h3.swap")).toBe(true);
      for (const c of v.clips) expect(c.inputs.who).toBe(WHO);
    });

    it("across grids (H3 to SCAIL-2): every window made anew, the rendered ones too, their videos left in the library", async () => {
      const { tl, v } = await madeWith("h3.swap");
      const video = await asset("video");
      await takeFor(v.clips[0].id, video.id);
      const r = await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "scail.motion" });
      expect(r.switched).toBe(false);
      const after = await view(tl.id);
      expect(after.source.recipe).toBe("scail.motion");
      expect(after.clips.every((c: { recipe: string; take: unknown }) => c.recipe === "scail.motion" && !c.take)).toBe(true);
      expect(after.clips.map((c: { id: string }) => c.id)).toEqual(r.clips);
      expect(await t.db.selectFrom("assets").select("id").where("id", "=", video.id).where("deleted_at", "is", null).executeTakeFirst()).toBeTruthy();
      // one step: Undo brings the swap's clips back, the take among them
      await call("POST", `/api/timelines/${tl.id}/undo`);
      const back = await view(tl.id);
      expect(back.source.recipe).toBe("h3.swap");
      expect(back.clips[0].take?.asset.id).toBe(video.id);
    });

    it("is refused while a clip of the source renders", async () => {
      const { tl, v } = await madeWith("h3.swap");
      await t.db.insertInto("jobs").values({ id: newId(), owner_id: "local", recipe_id: "h3.swap", label: "x", inputs: "{}", status: "queued", priority: 0, clip_id: v.clips[1].id, created_at: now(), updated_at: now() } as never).execute();
      await expect(call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "scail.motion" })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("trimmed after Make (Timelines.trimSource)", () => {
    const madeSwap = async () => {
      const tl = await call("POST", "/api/timelines", { name: "zz-test source trim" });
      const meme = await asset("video");
      const photo = await asset("image");
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 0, toMs: 20000, recipe: "h3.swap", inputs: { who: "Swap the man in <Video 1> with the character in <Picture 1>.", references: [{ asset: photo.id, role: "person" }] } } });
      await call("POST", `/api/timelines/${tl.id}/source/make`);
      return { tl, v: await view(tl.id) };
    };
    const takeFor = async (clipId: string) => {
      const video = await asset("video");
      const take = newId();
      await t.db.insertInto("takes").values({ id: take, clip_id: clipId, asset_id: video.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() }).execute();
      await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clipId).execute();
      return take;
    };
    const ends = (v: { clips: Array<{ inputs: Record<string, number> }> }) => v.clips.map((c) => Math.round((c.inputs.sourceStart! + c.inputs.sourceSeconds!) * 1000));
    // where a window's own frames begin: past the 22 it carries from the one before (its run-up)
    const ownStart = (c: { inputs: Record<string, number> }) => Math.round(c.inputs.sourceStart! * 1000 + (22 * 1000) / 24);

    it("its end in sets the windows past it aside; out again brings the same clips back, takes and all", async () => {
      const { tl, v } = await madeSwap();
      expect(v.clips.length).toBeGreaterThanOrEqual(4);
      const ids = v.clips.map((c: { id: string }) => c.id);
      const take = await takeFor(ids.at(-1));
      const cut = ends(v)[1]!;
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: cut });
      const short = await view(tl.id);
      expect(short.clips.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 2));
      // the next window's own frames begin a moment before (its run-up): the end stops there
      expect(Math.abs(short.source.toMs - cut)).toBeLessThan(50);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const back = await view(tl.id);
      expect(back.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(back.clips.at(-1).take?.id).toBe(take);
    });

    it("an empty window shortened to the end gets its length back before the windows set aside return: no gap between them", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      const before = ends(v);
      const start = Math.round(v.clips[1].inputs.sourceStart! * 1000);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4000 });
      expect(ends(await view(tl.id))[1]).toBe(start + 4000);
      // shorter again, the shortened window itself set aside: it goes at its length before
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[0]! });
      expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 1));
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4000 });
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const back = await view(tl.id);
      expect(back.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(ends(back)).toEqual(before);
    });

    it("never shortens a rendered window: its end snaps to the window's nearer end", async () => {
      const { tl, v } = await madeSwap();
      await takeFor(v.clips[1].id);
      const [start, end] = [ownStart(v.clips[1]), ends(v)[1]!];
      // a little into it: back to where the window before ends, the window set aside
      const r1 = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 500 });
      expect(r1.toMs).toBe(ends(v)[0]);
      expect((await view(tl.id)).clips).toHaveLength(1);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      // most of the way through: on to its end, the window whole
      const r2 = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: end - 300 });
      expect(r2.toMs).toBe(end);
      const kept = await view(tl.id);
      expect(kept.clips).toHaveLength(2);
      expect(ends(kept)[1]).toBe(end);
    });

    const queued = (clipId: string, status: "queued" | "running" = "queued") =>
      t.db.insertInto("jobs").values({ id: newId(), owner_id: "local", recipe_id: "h3.swap", label: "x", inputs: "{}", status, priority: 0, clip_id: clipId, created_at: now(), updated_at: now() } as never).execute();

    it("two trims sent at once (one drag sent twice) keep the windows the first set aside, takes and all", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      const takes = [await takeFor(ids[2]), await takeFor(ids.at(-1))];
      const cut = ends(v)[1]!;
      await Promise.all([1, 2].map(() => call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: cut })));
      const short = await view(tl.id);
      expect(short.clips.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 2));
      expect(short.source.parked).toHaveLength(ids.length - 2);
      expect(short.source.parkedTakes).toBe(2);
      // one step: the second found nothing more to do
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const back = await view(tl.id);
      expect(back.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect([back.clips[2].take?.id, back.clips.at(-1).take?.id]).toEqual(takes);
    });

    it("never sets aside or shortens a window that renders or waits in the queue: refused, with no step to undo", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      await queued(ids[2], "running");
      const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/source/trim`, payload: { fromMs: 0, toMs: ends(v)[1]! } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error ?? res.body).toMatch(/Clip 3 is rendering or in the queue/);
      const after = await view(tl.id);
      expect(after.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(after.undo).toBe(v.undo);
      // the end in a window that waits: never shortened, the end snaps onto its end
      const r = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[2]! - 300 });
      expect(r.toMs).toBe(ends(v)[2]);
      expect(ends(await view(tl.id))[2]).toBe(ends(v)[2]);
    });

    it("a little out after a trim that shortened an empty window: that window made longer, the windows set aside kept for the end out", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      const take = await takeFor(ids[2]);
      const start = Math.round(v.clips[1].inputs.sourceStart! * 1000);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4000 });
      const r = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4500 });
      expect(r.toMs).toBe(start + 4500);
      const small = await view(tl.id);
      expect(small.clips.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 2));
      expect(ends(small)[1]).toBe(start + 4500);
      expect(small.source.parked).toHaveLength(ids.length - 2);
      expect(small.source.parkedTakes).toBe(1);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const back = await view(tl.id);
      expect(back.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(ends(back)).toEqual(ends(v));
      expect(back.clips[2].take?.id).toBe(take);
    });

    it("out while the shortened window renders: its length left under the render, the windows set aside kept, no step", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      const start = Math.round(v.clips[1].inputs.sourceStart! * 1000);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4000 });
      const short = await view(tl.id);
      await queued(ids[1], "running");
      const r = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      expect(r).toEqual({ clips: [], toMs: start + 4000 });
      const after = await view(tl.id);
      expect(after.clips[1].inputs.sourceSeconds).toBe(short.clips[1].inputs.sourceSeconds);
      expect(after.source.parked).toHaveLength(ids.length - 2);
      expect(after.undo).toBe(short.undo);
      // the render done (its job gone), the same drag gives it its length back and the windows set aside return
      await t.db.deleteFrom("jobs").execute();
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(ids);
    });

    it("a little into a window that renders: the end snaps onto its end, as into a rendered one, not refused", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      await queued(ids[2], "running");
      const r = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ownStart(v.clips[2]) + 300 });
      expect(r.toMs).toBe(ends(v)[2]);
      const after = await view(tl.id);
      expect(after.clips.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 3));
      expect(ends(after)[2]).toBe(ends(v)[2]);
    });

    it("cut again, each empty window's own prompt goes to the window made where it lay", async () => {
      const { tl, v } = await madeSwap();
      const words = ["", "He walks to the door.", "He opens it and looks out.", "He turns back.", "He sits down."];
      for (const [k, c] of v.clips.entries()) if (k > 0) await call("PATCH", `/api/clips/${c.id}`, { inputs: { ...c.inputs, description: words[k] ?? `Part ${k}.` } });
      const was = (await view(tl.id)).clips as Array<{ inputs: Record<string, number | string> }>;
      await call("PATCH", `/api/timelines/${tl.id}`, { source: { windowMs: 3800 } });
      await call("POST", `/api/timelines/${tl.id}/source/make`, { again: true });
      const out = (await view(tl.id)).clips as Array<{ recipe: string; inputs: Record<string, number | string> }>;
      // cut on another grid: the windows no longer match one for one
      expect(out.map((c) => c.inputs.sourceStart)).not.toEqual(was.map((c) => c.inputs.sourceStart));
      for (const c of out.slice(1)) {
        const mid = Number(c.inputs.sourceStart) + Number(c.inputs.sourceSeconds) / 2;
        const there = was.find((p) => mid >= Number(p.inputs.sourceStart) && mid < Number(p.inputs.sourceStart) + Number(p.inputs.sourceSeconds));
        expect(c.recipe).toBe("h3.motion");
        if (there && there !== was[0]) expect(String(c.inputs.description).startsWith(String(there.inputs.description))).toBe(true);
      }
      expect(new Set(out.slice(1).map((c) => c.inputs.description)).size).toBeGreaterThan(1);
      // a window none of the new ones has its middle in gives its prompt to the nearest, after what that one has: none lost
      for (const said of words.slice(1, was.length)) expect(out.some((c) => String(c.inputs.description).includes(said))).toBe(true);
    });

    it("gives another form of the grid to every window but one that renders, which keeps the form its render was sent with", async () => {
      const { tl, v } = await madeSwap();
      const ids = v.clips.map((c: { id: string }) => c.id);
      await queued(ids[2], "running");
      const r = await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "h3.swap" });
      expect(r.switched).toBe(true);
      const out = await view(tl.id);
      expect(out.clips.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(out.clips.map((c: { recipe: string }) => c.recipe)).toEqual(ids.map((_: string, k: number) => (k === 2 ? "h3.motion" : "h3.swap")));
      expect(out.clips[2].inputs).toEqual(v.clips[2].inputs);
      expect(out.source.recipe).toBe("h3.swap");
    });

    it("keeps the first window whatever the end asks: an empty one as long as a window can be, a rendered one whole", async () => {
      const { tl, v } = await madeSwap();
      const r = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 1000 });
      const short = await view(tl.id);
      expect(short.clips).toHaveLength(1);
      expect(short.clips[0].id).toBe(v.clips[0].id);
      // H3's grid: 22 frames at the least, at 24 fps
      expect(r.toMs).toBeGreaterThan(900);
      expect(short.source.toMs).toBe(r.toMs);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(v.clips.map((c: { id: string }) => c.id));
      await takeFor(v.clips[0].id);
      const whole = await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 1000 });
      expect(whole.toMs).toBe(ends(v)[0]);
      expect((await view(tl.id)).clips).toHaveLength(1);
    });

    it("drops the windows set aside when the source is made anew with another grid's model: a trim out never brings the old model's back", async () => {
      const { tl, v } = await madeSwap();
      await takeFor(v.clips[2].id);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[1]! });
      await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "scail.motion" });
      const anew = await view(tl.id);
      expect(anew.source.parked ?? []).toEqual([]);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const out = await view(tl.id);
      expect(out.clips.every((c: { recipe: string; take: unknown }) => c.recipe === "scail.motion" && !c.take)).toBe(true);
      expect(out.clips.map((c: { id: string }) => c.id)).not.toContain(v.clips[2].id);
    });

    it("gives the windows set aside the new form with the others in place: a trim out brings them back made with it", async () => {
      const { tl, v } = await madeSwap();
      const take = await takeFor(v.clips[2].id);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[1]! });
      await call("POST", `/api/timelines/${tl.id}/source/form`, { recipe: "h3.motion" });
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const out = await view(tl.id);
      expect(out.clips.map((c: { id: string }) => c.id)).toEqual(v.clips.map((c: { id: string }) => c.id));
      expect(out.clips.every((c: { recipe: string }) => c.recipe === "h3.motion")).toBe(true);
      expect(out.clips[2].inputs.sourceStart).toBe(v.clips[2].inputs.sourceStart);
      expect(out.clips[2].take?.id).toBe(take);
    });

    it("keeps a take set aside safe: its video in use, and a trim out still works once it is erased (the window back without it)", async () => {
      const { tl, v } = await madeSwap();
      await takeFor(v.clips[2].id);
      const video = (await t.db.selectFrom("takes").select("asset_id").where("clip_id", "=", v.clips[2].id).executeTakeFirstOrThrow()).asset_id;
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[1]! });
      const { inUse } = await import("../src/sweep");
      expect((await inUse(t.db)).get(video)).toBe("a timeline");
      // erased all the same (by hand, outside the app): the window comes back with no take, and the trims after it work
      await t.db.deleteFrom("assets").where("id", "=", video).execute();
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
      const out = await view(tl.id);
      expect(out.clips.map((c: { id: string }) => c.id)).toEqual(v.clips.map((c: { id: string }) => c.id));
      expect(out.clips[2].take).toBeFalsy();
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: ends(v)[1]! });
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: 20000 });
    });

    it("shortens an empty window the end falls in, and moving the start makes every window anew (one step to undo)", async () => {
      const { tl, v } = await madeSwap();
      const start = Math.round(v.clips[1].inputs.sourceStart! * 1000);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 0, toMs: start + 4000 });
      const short = await view(tl.id);
      expect(short.clips).toHaveLength(2);
      expect(ends(short)[1]).toBe(start + 4000);
      await takeFor(short.clips[0].id);
      await call("POST", `/api/timelines/${tl.id}/source/trim`, { fromMs: 2000, toMs: start + 4000 });
      const moved = await view(tl.id);
      expect(moved.source.fromMs).toBe(2000);
      expect(moved.clips[0].inputs.sourceStart).toBe(2);
      expect(moved.clips.every((c: { take: unknown }) => !c.take)).toBe(true);
      await call("POST", `/api/timelines/${tl.id}/undo`);
      const undone = await view(tl.id);
      expect(undone.source.fromMs).toBe(0);
      expect(undone.clips[0].take).toBeTruthy();
    });
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
