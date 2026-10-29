import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makePng } from "@afflatus/comfy/testing";
import { describe, expect, it, vi } from "vitest";
import type { DraftEdit } from "../src/mcpDrafts";
import type { KitEdit } from "../src/mcpKit";
import type { TimelineEdit } from "../src/mcpTimelines";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { timelineSuite } from "./timelineKit";

/**
 * An agent's change and the user's own, made at the same moment (card #134): neither is lost, and the toast's Undo never
 * puts an old value back over a newer one. Through the SDK's own client over HTTP, as Claude Code reaches /mcp, on a
 * pretend ComfyUI; nothing renders.
 */

const s = timelineSuite();

async function connect(): Promise<Client> {
  const res = await s.t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test make", start: "make" } });
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

/** The live events of one kind sent while `work` runs (a timeline's "going" word left out). */
async function heard<T>(kind: string, work: () => Promise<unknown>): Promise<T[]> {
  const got: T[] = [];
  const on = (e: T & { going?: true }) => void (e.going || got.push(e));
  s.t.services.queue.events.on(kind, on);
  try {
    await work();
  } finally {
    s.t.services.queue.events.off(kind, on);
  }
  return got;
}

const wait = (ms: number) => new Promise((go) => setTimeout(go, ms));
const inputsOf = async (clip: string) => JSON.parse((await s.t.db.selectFrom("clips").select("inputs").where("id", "=", clip).executeTakeFirstOrThrow()).inputs) as Record<string, unknown>;

/** A timeline of two H3 clips with their prompt written: its id and the clips'. */
async function twoClips(c: Client) {
  const { id } = await ok(c, "new_timeline", { name: "zz-test races" });
  await ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }] });
  for (const n of [1, 2]) await ok(c, "edit_clip", { timeline: id, clip: n, set: { description: `zz-test shot ${n}` } });
  const read = await ok(c, "read_timeline", { timeline: id });
  return { id: id as string, clips: read.clips.map((x: { id: string }) => x.id) as string[] };
}

describe.skipIf(!ffmpegThere)("an agent's timeline change beside the user's", { timeout: FFMPEG_TIMEOUT * 2 }, () => {
  it("edit_clip works from the clip as it is in the timeline's turn: a save of the user's made meanwhile stays (D2)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id, clips } = await twoClips(c);
    const t = s.t.services.timelines;
    // the timeline's turn held while the agent's call comes: the user's save lands in it after the agent read the timeline
    // (where the agent read it before its turn), before the agent writes
    let open!: () => void;
    const opened = new Promise<void>((go) => (open = go));
    const held = t.history.oneAtATime(id, async () => {
      await opened;
      await t.editClip(clips[1]!, { inputs: { ...(await inputsOf(clips[1]!)), description: "zz-test typed by the user" } });
    });
    const agent = ok(c, "edit_clip", { timeline: id, clip: 2, set: { seed: 7 } });
    await wait(400);
    open();
    await held;
    await agent;
    expect(await inputsOf(clips[1]!)).toMatchObject({ description: "zz-test typed by the user", seed: 7 });
    await c.close();
  });

  it("says the forms it changed, before and after, for the editor to lay over what is typed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id, clips } = await twoClips(c);
    const [e] = await heard<TimelineEdit>("timelineEdit", () => ok(c, "edit_clip", { timeline: id, clip: 1, set: { seed: 3 } }));
    expect(e!.inputs).toEqual({ [clips[0]!]: { was: { description: "zz-test shot 1" }, now: { description: "zz-test shot 1", seed: 3 } } });
    expect(e!.steps).toHaveLength(1);
    // a save of the form the clip holds already keeps no step: the editor saving its typing again after laying the agent's
    // values over it leaves Undo on the agent's change
    const before = await t(id);
    await s.t.services.timelines.editClip(clips[0]!, { inputs: { description: "zz-test shot 1", seed: 3 } });
    expect(await t(id)).toBe(before);
    await c.close();
  });

  it("takes a list of actions back whole from the toast, and refuses (409) once the user changed the timeline after it (D5)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id } = await twoClips(c);
    const [e] = await heard<TimelineEdit>("timelineEdit", () => ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }, { do: "settings", name: "zz-test renamed" }] }));
    expect(e!.steps).toHaveLength(3);
    expect(e!.step).toBe(e!.steps!.at(-1));
    const read = async () => (await s.t.app.inject({ method: "GET", url: `/api/timelines/${id}` })).json() as { name: string; clips: unknown[] };
    expect((await read()).clips).toHaveLength(4);
    const undo = await s.t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: { steps: e!.steps } });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await read()).toMatchObject({ name: "zz-test races", clips: [expect.anything(), expect.anything()] });

    // again, then a change of the user's on top: the toast's Undo is refused, nothing taken back
    const [again] = await heard<TimelineEdit>("timelineEdit", () => ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }] }));
    await s.t.app.inject({ method: "PATCH", url: `/api/timelines/${id}`, payload: { name: "zz-test the user's" } });
    const refused = await s.t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: { steps: again!.steps } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error ?? refused.body).toMatch(/changed since/);
    expect(await read()).toMatchObject({ name: "zz-test the user's" });
    expect((await read()).clips).toHaveLength(4);
    await c.close();
  });

  it("never names the user's step: one made while the agent's list runs is neither ringed nor taken back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const { id, clips } = await twoClips(c);
    const t = s.t.services.timelines;
    // the user's change asked while the agent's list runs: it waits for the list's turn, and comes after it
    const got = heard<TimelineEdit>("timelineEdit", async () => {
      const agent = ok(c, "edit_timeline", { timeline: id, actions: [{ do: "add", form: "h3.video" }, { do: "add", form: "h3.video" }] });
      await wait(30);
      const user = t.editClip(clips[0]!, { inputs: { description: "zz-test the user's words" } });
      await Promise.all([agent, user]);
    });
    const [e] = await got;
    expect(e!.clips).not.toContain(clips[0]);
    const last = await t.history.last(id);
    // whichever came first, the toast's steps are the agent's two alone
    expect(e!.steps).toHaveLength(2);
    if (last!.id !== e!.steps!.at(-1)) expect((await s.t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: { steps: e!.steps } })).statusCode).toBe(409);
    await c.close();
  });
});

/** How many steps a timeline's Undo holds. */
async function t(id: string): Promise<number> {
  return (await s.t.db.selectFrom("timeline_history").select("id").where("timeline_id", "=", id).execute()).length;
}

describe("an agent's Prompt kit change", () => {
  const upload = async (name: string) =>
    (await s.t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json() as { id: string };

  it("undone from its toast brings back a picture of the kit's own that it had sent to the bin (D3)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const up = await upload("zz-test face");
    // uploaded for the kit, as the person's picture slot does
    await s.t.db.updateTable("assets").set({ origin: "kit" }).where("id", "=", up.id).execute();
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann", def: { pictures: [up.id] } });
    const [e] = await heard<KitEdit>("kit", () => ok(c, "edit_kit_item", { item: person.id, set: { pictures: [] } }));
    const row = () => s.t.db.selectFrom("assets").select(["deleted_at"]).where("id", "=", up.id).executeTakeFirstOrThrow();
    expect((await row()).deleted_at).not.toBeNull();
    // the page's Undo: the def as it was, saved through the kit's own save
    const def = (await s.t.app.inject({ method: "GET", url: "/api/entities?kind=person" })).json().items[0].def;
    const back = await s.t.app.inject({ method: "PUT", url: `/api/entities/${person.id}`, payload: { def: { ...def, pictures: e!.fields.find((f) => f.key === "pictures")!.was } } });
    expect(back.statusCode, back.body).toBe(200);
    expect((await row()).deleted_at).toBeNull();
    await c.close();
  });

  it("says when it was saved, for a page whose save went after it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann" });
    const [e] = await heard<KitEdit>("kit", () => ok(c, "edit_kit_item", { item: person.id, set: { tags: "1girl" } }));
    const item = (await s.t.app.inject({ method: "GET", url: "/api/entities?kind=person" })).json().items[0];
    expect(e!.saved).toBe(item.updatedAt);
    await c.close();
  });

  it("sets a preset's form, cast and files, and null takes them out (D6)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann" });
    const preset = await ok(c, "new_kit_item", { kind: "preset", name: "zz-test look" });
    const files = [{ file: "zz-test.safetensors", folder: "loras", url: "https://example.com/zz-test.safetensors" }];
    const done = await ok(c, "edit_kit_item", { item: preset.id, set: { recipe: "h3.video", look: { cast: [{ id: person.id }], style: null, snippets: [] }, files } });
    expect(done.changed.sort()).toEqual(["files", "look", "recipe"]);
    expect(done.item.def).toMatchObject({ recipe: "h3.video", look: { cast: [{ id: person.id }] }, files });
    const r = await c.callTool({ name: "edit_kit_item", arguments: { item: preset.id, set: { recipe: "zz-test.none" } } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no form zz-test.none/);
    const cleared = await ok(c, "edit_kit_item", { item: preset.id, set: { recipe: null, files: null } });
    expect(cleared.item.def.recipe).toBeUndefined();
    expect(cleared.item.def.files).toBeUndefined();
    await c.close();
  });
});

describe("an agent's draft change", () => {
  it("says when it was saved, and edit_draft picks the form in the draft's own turn", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await connect();
    const d = await ok(c, "new_draft", { form: "h3.video" });
    const [e] = await heard<DraftEdit>("draft", () => ok(c, "edit_draft", { draft: d.id, set: { seed: 5 } }));
    const now = (await s.t.app.inject({ method: "GET", url: `/api/drafts/${d.id}` })).json();
    expect(e!.saved).toBe(now.updatedAt);
    expect(now.forms["h3.video"]).toMatchObject({ seed: 5 });
    await c.close();
  });
});
