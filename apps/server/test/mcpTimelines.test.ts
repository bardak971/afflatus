import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { newAssetRow } from "../src/media";
import type { TimelineEdit } from "../src/mcpTimelines";
import { TOOLS } from "../src/mcpTools";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { timelineSteps, timelineSuite } from "./timelineKit";

/**
 * The timelines from outside (mcpTimelines.ts), through the SDK's own client over HTTP as Claude Code reaches /mcp, on a
 * pretend ComfyUI with H3's files: each tool through the editor's own model, with its refusals (Split on a recording's
 * clip, a move out of a recording's order, a continuation with nothing to carry on from); a change undone; the
 * "timelineEdit" live event an open editor follows.
 */

const s = timelineSuite();
const steps = timelineSteps(s);

async function connect(start: "look" | "make" = "make"): Promise<Client> {
  const res = await s.t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  const token = res.json().token as string;
  if (!s.t.app.server.listening) await s.t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (s.t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r));
};
const refused = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};

/** The "timelineEdit" events sent while `work` runs. */
async function heard(work: () => Promise<unknown>): Promise<TimelineEdit[]> {
  const got: TimelineEdit[] = [];
  // the change itself, not the word sent before it that a token is at work (`going`)
  const on = (e: TimelineEdit) => void (e.going || got.push(e));
  s.t.services.queue.events.on("timelineEdit", on);
  try {
    await work();
  } finally {
    s.t.services.queue.events.off("timelineEdit", on);
  }
  return got;
}

/** A timeline of three H3 clips with their prompt written, the second and third carrying on: its id and the clips'. */
async function threeClips(c: Client) {
  const { id } = await ok(c, "new_timeline", { name: "zz-test evening" });
  await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }] });
  for (const n of [1, 2, 3]) await ok(c, "edit_clip", { timeline: id, clip: n, set: { description: `zz-test shot ${n}: she walks to the window.` } });
  const read = await ok(c, "read_timeline", { timeline: id });
  return { id: id as string, clips: read.clips.map((x: { id: string }) => x.id) as string[], read };
}

/** A recording of 15 s with two pauses (at 4.7 and 10.2 s), uploaded to the library: its id. */
async function recording(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-mcp-recording-"));
  try {
    const wav = join(dir, "talk.wav");
    const parts = ["sine=frequency=220:duration=4.5", "anullsrc=r=48000:cl=mono,atrim=duration=0.4", "sine=frequency=220:duration=5.1", "anullsrc=r=48000:cl=mono,atrim=duration=0.4", "sine=frequency=220:duration=4.6"];
    const filter = `${parts.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`).join(";")};${parts.map((_, k) => `[a${k}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...parts.flatMap((p) => ["-f", "lavfi", "-i", p]), "-filter_complex", filter, "-map", "[out]", wav]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    const res = await s.t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20talking.wav", headers: { "content-type": "audio/wav" }, payload: readFileSync(wav) });
    return res.json().id as string;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ffmpegThere)("the timelines from outside", { timeout: FFMPEG_TIMEOUT * 2 }, () => {
  it("are read with Look, changed only with Make", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const make = await connect();
    const { id } = await threeClips(make);
    const look = await connect("look");
    const names = (await look.listTools()).tools.map((x) => x.name);
    for (const n of ["list_timelines", "read_timeline", "view_timeline", "new_timeline", "edit_timeline", "edit_clip", "render_clips", "use_take", "finish", "export", "undo", "redo"]) expect(names).toContain(n);
    expect(names).toHaveLength(TOOLS.length);
    expect((await ok(look, "list_timelines")).map((x: { id: string }) => x.id)).toEqual([id]);
    const read = await ok(look, "read_timeline", { timeline: id });
    expect(read.clips).toHaveLength(3);
    expect(read.clips[1]).toMatchObject({ n: 2, kind: "video", form: "h3.video", take: null, join: { joined: "seamless", state: "not rendered yet" } });
    expect(read.needsALook[0]).toMatchObject({ clips: [1, 2, 3], mend: "render_clips (all)" });
    await refused(look, "edit_timeline", { timeline: id, actions: [{ do: "remove", clips: [1] }] }, /needs Make/);
    await refused(look, "undo", { timeline: id }, /needs Make/);
    await refused(look, "render_clips", { timeline: id }, /needs Make/);
    await look.close();
    await make.close();
  });

  it("renders three seamless clips in order, sees them, trims, swaps a take, sets a transition and undoes it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id, clips } = await threeClips(c);
    // all that are left: the three, each carrying on from the take of the one before as it comes
    const r = await ok(c, "render_clips", { timeline: id });
    expect(r).toMatchObject({ clips: [1, 2, 3], takes: 1 });
    expect(r.jobs).toHaveLength(3);
    const jobs = await s.t.db.selectFrom("jobs").select(["id", "clip_id", "depends_on", "mcp_token_id"]).where("id", "in", r.jobs).execute();
    expect(jobs.every((j) => j.mcp_token_id)).toBe(true);
    for (const [k, j] of r.jobs.entries()) {
      if (k) expect(jobs.find((x) => x.id === j)!.depends_on).toBe(r.jobs[k - 1]);
    }
    for (const n of [1, 2, 3]) await steps.finish(s.clips.three, n);
    let read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips.map((x: { take: unknown }) => Boolean(x.take))).toEqual([true, true, true]);
    expect(read.clips[1].join.state).toBe("follows on");
    expect(read.length.rendered).toBe(3);

    // card #161: a seamless take that cut to another shot where its run-up ends is said on the join, the take and Needs a look
    const made = await s.t.db.selectFrom("assets").select("generation_id").where("id", "=", read.clips[1].take.item).executeTakeFirstOrThrow();
    const measured = await s.t.db.selectFrom("generations").select("measure").where("id", "=", made.generation_id!).executeTakeFirstOrThrow();
    await s.t.db.updateTable("generations").set({ measure: JSON.stringify({ luma: 100, sharp: 10, handover: 20 }) }).where("id", "=", made.generation_id!).execute();
    const cuts = await ok(c, "read_timeline", { timeline: id });
    expect(cuts.clips[1].join.cutsHere).toMatch(/^×20\.0: the take that plays cut to another shot/);
    expect(cuts.clips[1].take.cutAtJoin).toMatch(/^×20\.0: the take cuts at the join/);
    expect(cuts.clips[2].join.cutsHere).toBeUndefined();
    expect(cuts.needsALook).toContainEqual({ clips: [2], what: expect.stringMatching(/^clip 2: the take cuts at the join: where its run-up ends the picture jumps ×20\.0/), mend: expect.stringMatching(/render_clips it again/) });
    // the same ×5 on a Wan take (16 frames a second, which the run-up's steps at 24 read twice) is no cut said (0.8.3 review)
    const recipe = (await s.t.db.selectFrom("generations").select("recipe_id").where("id", "=", made.generation_id!).executeTakeFirstOrThrow()).recipe_id;
    await s.t.db.updateTable("generations").set({ recipe_id: "wan.video", measure: JSON.stringify({ luma: 100, sharp: 10, handover: 5 }) }).where("id", "=", made.generation_id!).execute();
    const wan = await ok(c, "read_timeline", { timeline: id });
    expect(wan.clips[1].join.cutsHere).toBeUndefined();
    expect(wan.clips[1].take.cutAtJoin).toBeUndefined();
    expect(JSON.stringify(wan.needsALook ?? [])).not.toMatch(/cuts at the join/);
    await s.t.db.updateTable("generations").set({ recipe_id: recipe, measure: measured.measure }).where("id", "=", made.generation_id!).execute();

    // the contact sheet: a frame each, and the frames around each join
    const sheet = await c.callTool({ name: "view_timeline", arguments: { timeline: id } });
    expect(sheet.isError).toBeFalsy();
    const parts = sheet.content as Array<{ type: string; mimeType?: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
    expect(parts[1]!.mimeType).toBe("image/jpeg");
    const joins = await c.callTool({ name: "view_timeline", arguments: { timeline: id, joins: true } });
    expect(JSON.parse(textOf(joins)).facts.map((f: { join: string }) => f.join)).toEqual(["1→2", "2→3"]);

    // trimmed by what is seen, in the take's own time
    const take = read.clips[2].take;
    const trimmed = await heard(() => ok(c, "edit_timeline", { timeline: id, actions: [{ do: "trim", clip: 3, toMs: take.plays.toMs - 500 }] }));
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toMatchObject({ id, by: "zz-test make", clips: [clips[2]] });
    expect(trimmed[0]!.step).toBeTruthy();
    read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[2].take.plays.toMs).toBe(take.plays.toMs - 500);

    // another take of clip 2, then the first one made to play again
    await ok(c, "render_clips", { timeline: id, clips: [2] });
    await steps.finish(s.clips.three, 4);
    read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[1].otherTakes).toHaveLength(1);
    expect(await ok(c, "use_take", { timeline: id, clip: 2, take: 1 })).toMatchObject({ clip: 2, playing: "take 1" });
    expect((await ok(c, "read_timeline", { timeline: id })).clips[1].take.n).toBe(1);

    // a transition goes on a cut: the join into clip 3 is made one, and undo takes it back
    expect((await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "join", clip: 3, transition: { kind: "dissolve", ms: 500 } }] })).done[0]).toMatch(/dissolve of 500 ms into clip 3/);
    read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[2].join).toMatchObject({ joined: "cut", transition: { kind: "dissolve", ms: 500 } });
    expect(await ok(c, "undo", { timeline: id })).toMatchObject({ undone: expect.any(String) });
    read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips[2].join.joined).toBe("seamless");
    expect(read.clips[2].join.transition).toBeUndefined();
    await ok(c, "redo", { timeline: id });
    expect((await ok(c, "read_timeline", { timeline: id })).clips[2].join.transition).toMatchObject({ kind: "dissolve" });

    // a finish through the Finish dialog's route: its jobs carry the token, so that one without Spend stays off rented pods
    const fin = await ok(c, "finish", { timeline: id, route: "seedvr", factor: 2, clips: [1] });
    expect(fin.jobs).toHaveLength(1);
    expect((await s.t.db.selectFrom("jobs").select(["recipe_id", "mcp_token_id"]).where("id", "=", fin.jobs[0]).executeTakeFirstOrThrow())).toMatchObject({ recipe_id: "afflatus.cut", mcp_token_id: expect.any(String) });
    await refused(c, "finish", { timeline: id, route: "seedvr", factor: 2, clips: [1] }, /Nothing to finish.*clip 1: a render or a finish is on its way/);

    // the export waits in the queue as the editor's does, and is not queued twice
    const ex = await ok(c, "export", { timeline: id });
    expect((await ok(c, "export", { timeline: id })).job).toBe(ex.job);
    // queued by this token: its own, to cancel (card #188)
    expect((await s.t.db.selectFrom("jobs").select("mcp_token_id").where("id", "=", ex.job).executeTakeFirstOrThrow()).mcp_token_id).toEqual(expect.any(String));
    // once done, job names the video it made (an export has no generation: its video is the timeline's export)
    await s.t.db.insertInto("assets").values(newAssetRow({ id: "exported1", kind: "video", origin: "exported", name: "the export", file_key: "assets/ex/exported1.mp4", mime: "video/mp4", bytes: 1, width: 640, height: 360, duration_ms: 9000, has_sound: 1, created_at: new Date().toISOString() })).execute();
    await s.t.db.updateTable("timelines").set({ export_asset_id: "exported1" }).where("id", "=", id).execute();
    await s.t.db.updateTable("jobs").set({ status: "done", finished_at: new Date().toISOString() }).where("id", "=", ex.job).execute();
    expect((await ok(c, "job", { job: ex.job })).made).toEqual([{ item: "exported1", kind: "video", width: 640, height: 360, durationMs: 9000 }]);
    await c.close();
  });

  it("refuses a continuation with nothing to carry on from, and a clip whose form is not filled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id } = await threeClips(c);
    // card #128: clip 2 carries on from clip 1, which has no take and none coming
    await refused(c, "render_clips", { timeline: id, clips: [2] }, /Clip 2 carries on from clip 1, which has no take/);
    const read = await ok(c, "read_timeline", { timeline: id });
    // the chain of three said once, not once a join
    const chained = read.needsALook.filter((r: { what: string }) => /carr(y|ies) on from/.test(r.what));
    expect(chained).toEqual([{ clips: [1, 2, 3], what: expect.stringMatching(/^clips 2–3 each carry on from the clip before, which has no take/), mend: expect.stringMatching(/render_clips with clips 1–3/) }]);
    expect(await s.t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    // an empty prompt: Render is refused for that clip, as its button is greyed
    await ok(c, "edit_clip", { timeline: id, clip: 1, set: { description: null } });
    await refused(c, "render_clips", { timeline: id, clips: [1] }, /Clip 1 cannot be rendered: write its/);
    // a value the form would refuse
    await refused(c, "edit_clip", { timeline: id, clip: 1, set: { nothing: 1 } }, /has no input nothing/);
    await c.close();
  });

  it("removes clips as a ripple cut that undo brings back, and holds the toast's Undo to its own step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id, clips } = await threeClips(c);
    const got = await heard(async () => {
      const r = await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "remove", clips: [2] }] });
      expect(r.done[0]).toMatch(/removed clip 2: the clips after closed the gap\. undo brings it back/);
    });
    expect((await ok(c, "read_timeline", { timeline: id })).clips.map((x: { id: string }) => x.id)).toEqual([clips[0], clips[2]]);
    // a step other than the last: refused, the timeline as it was
    const wrong = await s.t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: { step: "not-the-last" } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error ?? wrong.body).toMatch(/changed since/);
    // the toast's own step: taken back
    const back = await s.t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: { step: got[0]!.step } });
    expect(back.statusCode).toBe(200);
    expect((await ok(c, "read_timeline", { timeline: id })).clips.map((x: { id: string }) => x.id)).toEqual(clips);

    // a list runs in order, and stops at a refused action, saying what was done before it
    const r = await c.callTool({ name: "edit_timeline", arguments: { timeline: id, actions: [{ do: "move", clip: 3, after: null }, { do: "split", clip: 1, atMs: 100 }] } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Action 2 \(split\) was refused: This clip has no take yet.*The 1 action before it was done \(moved clip 3: it is clip 1 now\)/);
    expect((await ok(c, "read_timeline", { timeline: id })).clips.map((x: { id: string }) => x.id)).toEqual([clips[2], clips[0], clips[1]]);
    await c.close();
  });

  it("cuts a recording into Lip sync clips with a ± window, and refuses Split and a move out of its order", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id } = await ok(c, "new_timeline", { name: "zz-test talk" });
    const sound = await recording();
    const made = await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "recording", item: sound, seconds: 5, window: 1.5 }] });
    expect(made.done[0]).toMatch(/made 3 Lip sync clips from the recording \(clips 1–3\), cut at its pauses about every 5 s ± 1.5 s/);
    const read = await ok(c, "read_timeline", { timeline: id });
    expect(read.clips.map((x: { form: string }) => x.form)).toEqual(["h3.lipsync", "h3.lipsync", "h3.lipsync"]);
    expect(read.lanes.audio[0]).toMatchObject({ recording: sound, clips: [1, 2, 3], cut: { seconds: 5, window: 1.5 } });
    // its clips keep the recording's order, and none of them splits
    await refused(c, "edit_timeline", { timeline: id, actions: [{ do: "move", clip: 3, after: null }] }, /The clips of a recording play in its order/);
    // split needs a take first; with none, that is said: give clip 1 one by hand is not possible here, so its refusal is read on a rendered one below
    await ok(c, "edit_clip", { timeline: id, clip: 1, set: { description: "zz-test she talks." } });
    await ok(c, "render_clips", { timeline: id, clips: [1] });
    await steps.finish(s.clips.three, 1);
    await refused(c, "edit_timeline", { timeline: id, actions: [{ do: "split", clip: 1, atMs: 1000 }] }, /one of a recording's: its part of it cannot be split in two/);
    // removing a clip from its middle cuts its part out, and bring_back puts it back
    const removed = await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "remove", clips: [2] }] });
    expect(removed.done[0]).toMatch(/its part was cut out of the recording/);
    const after = await ok(c, "read_timeline", { timeline: id });
    expect(after.clips).toHaveLength(2);
    expect(after.lanes.audio[0].removed).toEqual([expect.objectContaining({ beforeClip: 2, clips: 1 })]);
    await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "bring_back", before: 2 }] });
    expect((await ok(c, "read_timeline", { timeline: id })).clips).toHaveLength(3);
    await c.close();
  });
});
