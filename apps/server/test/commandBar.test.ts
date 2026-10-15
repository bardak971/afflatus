import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import type { RenderRow } from "../src/renderDigests";
import { sdxl } from "../../../packages/workflows/test/fixtures";
import { prepare, score } from "../../web/src/bar/match";
import { CHECKPOINT, complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const call = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

/** An item of the library straight in the table. */
const asset = (folder: string | null, opts: { name?: string; kind?: "image" | "video" | "audio"; origin?: "uploaded" | "mask" | "kit"; binned?: boolean; bytes?: number; generation?: string; at?: string } = {}) => {
  const id = newId();
  return newAssetRow({
    id, kind: opts.kind ?? "image", origin: opts.origin ?? "uploaded", name: opts.name ?? "", file_key: `assets/${id}.png`, thumb_key: opts.kind === "audio" ? null : `thumbs/${id}.webp`, mime: "image/png",
    bytes: opts.bytes ?? 10, width: opts.kind === "audio" ? null : 64, height: opts.kind === "audio" ? null : 48, duration_ms: opts.kind === "image" || !opts.kind ? null : 5000, fps: null, has_sound: 0,
    folder_id: folder, generation_id: opts.generation ?? null, source_id: null, deleted_at: opts.binned ? "2026-10-08T00:00:00.000Z" : null, ...(opts.at ? { created_at: opts.at } : {}),
  });
};
const put = async (...rows: Array<ReturnType<typeof asset>>) => {
  await t.db.insertInto("assets").values(rows).execute();
  return rows.map((r) => r.id);
};

type Entry = { kind: string; id: string } & Record<string, unknown>;
const index = async (qs = ""): Promise<Entry[]> => (await get(t.app, `/api/command-index${qs}`)).json().entries;
/** The library's items the bar's search finds for what is typed. */
const items = async (q: string): Promise<Entry[]> => (await get(t.app, `/api/command-items?q=${encodeURIComponent(q)}`)).json().entries;

describe("the command bar's index", () => {
  it("holds every timeline, draft, project and folder and the newest items, with labels, and the project of an item is its folder's", async () => {
    const harbor = await call("POST", "/api/projects", { name: "Harbor walk" });
    const shots = await call("POST", "/api/folders", { name: "shots", parentId: harbor.folderId });
    const loose = await call("POST", "/api/folders", { name: "loose", parentId: null });
    const [inRoot, inShots, unnamedVideo, unnamedSound, inbox, binned, mask, kit] = await put(
      asset(harbor.folderId, { name: "Pier at dawn", bytes: 100 }),
      asset(shots.id, { name: "Gulls", bytes: 20 }),
      asset(shots.id, { kind: "video", bytes: 3 }),
      asset(loose.id, { kind: "audio", bytes: 4 }),
      asset(null, { name: "Loose one" }),
      asset(shots.id, { name: "In the bin", binned: true }),
      asset(shots.id, { origin: "mask" }),
      asset(shots.id, { origin: "kit" }),
    );
    const tl = await call("POST", "/api/timelines", { name: "Harbor cut", project: harbor.id });
    const named = await call("POST", "/api/drafts", { recipe: "sdxl.text-to-picture", project: harbor.id });
    await call("PUT", `/api/drafts/${named.id}`, { name: "Night market" });
    const blank = await call("POST", "/api/drafts", { recipe: "sdxl.text-to-picture" });
    // two renders made from the named draft, on two models: SDXL first, then FLUX
    for (const [family, at] of [["sdxl", "2026-01-01T00:00:00.000Z"], ["flux", "2026-01-02T00:00:00.000Z"]] as const) {
      await t.db.insertInto("generations").values({ id: newId(), owner_id: "local", recipe_id: "sdxl.text-to-picture", recipe_version: 1, family, inputs: "{}", resolved: "{}", gen_ms: 1, draft_id: named.id, created_at: at }).execute();
    }

    const answer = (await get(t.app, "/api/command-index")).json() as { entries: Entry[]; inboxItems: number };
    const entries = answer.entries;
    const of = (id: string) => entries.find((e) => e.id === id);
    // masks and kit pictures are not the library's, even when named; what is in the bin is found by the search (to be put back),
    // marked, and counted nowhere
    for (const id of [mask, kit]) expect(of(id!)).toBeUndefined();
    expect((await index(`?items=${mask},${kit}`)).find((e) => e.id === mask || e.id === kit)).toBeUndefined();
    expect(of(binned!)).toBeUndefined();
    expect((await items("in the bin")).find((e) => e.id === binned)).toMatchObject({ kind: "asset", label: "In the bin", project: harbor.id, folder: shots.id, inBin: true });
    expect((await index(`?items=${binned}`)).find((e) => e.id === binned)).toMatchObject({ inBin: true });
    // the loose sound (a folder of no project) and the loose picture: the Inbox's
    expect(answer.inboxItems).toBe(2);
    expect(of(inRoot!)!.inBin).toBeUndefined();
    expect(of(inRoot!)).toMatchObject({ kind: "asset", label: "Pier at dawn", project: harbor.id, folder: null, assetKind: "image", width: 64, height: 48, durationMs: null, bytes: 100, hasThumb: true });
    expect(of(inShots!)).toMatchObject({ label: "Gulls", project: harbor.id, folder: shots.id });
    expect(of(unnamedVideo!)).toMatchObject({ label: "Video", assetKind: "video", durationMs: 5000 });
    expect(of(unnamedSound!)).toMatchObject({ label: "Sound", project: null, folder: loose.id, hasThumb: false });
    expect(of(inbox!)).toMatchObject({ label: "Loose one", project: null, folder: null });
    // the project stands for its root folder; its items are those of all its folders
    expect(of(harbor.folderId)).toBeUndefined();
    expect(of(harbor.id)).toMatchObject({ kind: "project", label: "Harbor walk", archived: false, timelines: 1, items: 3, bytes: 123 });
    expect(of(shots.id)).toMatchObject({ kind: "folder", label: "shots", project: harbor.id, parent: null, items: 2, linked: false });
    expect(of(loose.id)).toMatchObject({ kind: "folder", project: null, items: 1 });
    expect(of(tl.id)).toMatchObject({ kind: "timeline", label: "Harbor cut", project: harbor.id, clips: 0, durationMs: 0, plannedMs: 0, exported: false, unusedTakes: 0, unusedBytes: 0 });
    expect(of(named.id)).toMatchObject({ kind: "draft", label: "Night market", project: harbor.id, recipe: "sdxl.text-to-picture", renders: 2, models: ["flux", "sdxl"] });
    // named, with nothing written yet: no prompt to tell it apart by, but when it was started
    expect(of(named.id)).not.toHaveProperty("prompt");
    expect(typeof (of(named.id) as { createdAt?: string }).createdAt).toBe("string");
    // a blank draft is not written, so it is nowhere to be found
    expect(of(blank.id)).toBeUndefined();
    for (const e of entries) expect(typeof e.updatedAt).toBe("string");
  });

  it("says a timeline's rendered length and the length the editor plans, clips with nothing yet at their form's length", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Harbor walk" });
    const [picture] = await put(asset(null, { name: "Pier" }));
    const clip = (position: number, over: Record<string, unknown>) => t.db.insertInto("clips").values({
      id: newId(), timeline_id: tl.id, position, take_id: null, joined: "cut", recipe_id: "h3.video", inputs: "{}", kind: "video", still_asset_id: null, still_ms: 3000,
      sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: now(), updated_at: now(), ...over,
    }).execute();
    // a still that plays 3 s, a clip asking for 7 s and one asking for its model's default (5 s), neither rendered
    await clip(0, { kind: "still", recipe_id: null, still_asset_id: picture });
    await clip(1, { inputs: JSON.stringify({ seconds: 7 }) });
    await clip(2, {});
    const entry = (await index()).find((e) => e.id === tl.id);
    expect(entry).toMatchObject({ kind: "timeline", clips: 3, durationMs: 3000, plannedMs: 15_000 });
  });

  it("holds the imported workflows and the Prompt kit's entries, each with its kind", async () => {
    const found = (await post(t.app, "/api/workflows/inspect", sdxl)).json();
    const wf = (await post(t.app, "/api/workflows", { title: "zz-test Mine", model: "SDXL", source: "x.json", graph: sdxl, bindings: found.suggested })).json().id as string;
    const ada = await call("POST", "/api/entities", { kind: "person", name: "Ada" });
    const cine = await call("POST", "/api/entities", { kind: "snippet", name: "Cine look", def: { text: "Live-action, cinematic", category: "", style: null } });
    const entries = await index();
    expect(entries.find((e) => e.id === wf)).toMatchObject({ kind: "workflow", label: "zz-test Mine", output: "image", problem: false });
    expect(entries.find((e) => e.id === ada.id)).toMatchObject({ kind: "kit", label: "Ada", entity: "person", shipped: false });
    expect(entries.find((e) => e.id === cine.id)).toMatchObject({ kind: "kit", label: "Cine look", entity: "snippet", shipped: false });
    // gone from the kit, gone from the bar
    await call("DELETE", `/api/entities/${ada.id}`);
    expect((await index()).find((e) => e.id === ada.id)).toBeUndefined();
  });

  it("answers for 10 000 items in well under a second, small, and finds any of them by name", async () => {
    const projects = [];
    for (let p = 0; p < 5; p++) projects.push(await call("POST", "/api/projects", { name: `Project ${p}` }));
    const folders: string[] = [];
    for (const [p, project] of projects.entries()) {
      for (let f = 0; f < 10; f++) folders.push((await call("POST", "/api/folders", { name: `Shots ${p}.${f}`, parentId: project.folderId })).id);
    }
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const rows = Array.from({ length: 10_000 }, (_, i) => asset(i % 7 === 0 ? null : folders[i % folders.length]!, { name: `Harbor walk ${i}`, kind: (["image", "video", "audio"] as const)[i % 3], at: new Date(base + i * 1000).toISOString() }));
    // SQLite takes so many values per statement: a few hundred rows at a time
    for (let i = 0; i < rows.length; i += 500) await t.db.insertInto("assets").values(rows.slice(i, i + 500)).execute();
    for (let i = 0; i < 20; i++) await call("POST", "/api/timelines", { name: `Cut ${i}`, project: projects[i % 5].id });

    await get(t.app, "/api/command-index");
    const started = performance.now();
    const res = await get(t.app, "/api/command-index");
    const took = performance.now() - started;
    const entries = res.json().entries as Entry[];
    // the newest items only (the bar's Recent falls back on them), and every folder with its count
    expect(entries.filter((e) => e.kind === "asset").map((e) => e.label).slice(0, 2)).toEqual(["Harbor walk 9999", "Harbor walk 9998"]);
    expect(entries.filter((e) => e.kind === "asset").length).toBeLessThanOrEqual(30);
    expect(entries.filter((e) => e.kind === "folder")).toHaveLength(50);
    expect(entries.filter((e) => e.kind === "project").reduce((n, e) => n + (e.items as number), 0) + res.json().inboxItems).toBe(10_000);
    console.info(`[command-index] 10 000 items: ${took.toFixed(0)} ms, ${(res.body.length / 1e3).toFixed(1)} kB`);
    expect(took).toBeLessThan(600);
    expect(res.body.length).toBeLessThan(50_000);
    // the oldest item, found by its name as typed, first; and by its letters ("hw 12" is no name, "hrbrwlk12" its letters)
    const t0 = performance.now();
    expect((await items("Harbor walk 12"))[0]).toMatchObject({ label: "Harbor walk 12" });
    console.info(`[command-items] 10 000 items: ${(performance.now() - t0).toFixed(0)} ms`);
    expect((await items("hrbrwlk12")).map((e) => e.label)).toContain("Harbor walk 12");
  });
});

describe("the command bar's estimate", () => {
  it("is learned from render_stats, null before anything was rendered, and counts the jobs ahead", async () => {
    await t.services.queue.start();
    const input = { prompt: "Harbor walk at dawn", checkpoint: CHECKPOINT };
    const draft = await call("POST", "/api/drafts", { recipe: "sdxl.text-to-picture", forms: { "sdxl.text-to-picture": input }, count: 2 });
    const tl = await call("POST", "/api/timelines", { name: "Harbor cut" });
    const at = now();
    const clip = (position: number, take: string | null) => ({ id: newId(), timeline_id: tl.id, position, take_id: take, joined: "cut", recipe_id: "sdxl.text-to-picture", inputs: JSON.stringify(input), created_at: at, updated_at: at });
    // a fourth clip whose prompt is not written yet: it cannot render, so the card neither counts it nor times it
    await t.db.insertInto("clips").values([clip(0, null), clip(1, null), clip(2, null), { ...clip(3, null), inputs: JSON.stringify({ checkpoint: CHECKPOINT }) }] as never).execute();
    const card = async () => (await get(t.app, "/api/timelines")).json().items.find((x: { id: string }) => x.id === tl.id);
    expect((await card()).toRender).toBe(3);

    const estimate = async (qs: string) => (await get(t.app, `/api/command-estimate?${qs}`)).json();
    expect(await estimate(`draft=${draft.id}`)).toEqual({ ms: null, basis: 0, ahead: 0 });
    expect(await estimate(`timeline=${tl.id}`)).toEqual({ ms: null, basis: 0, ahead: 0 });

    // one render through the queue says which model file it was; its times are then put on record as the queue would
    const done = (await post(t.app, "/api/jobs", job({ prompt: "Harbor walk at dawn" }))).json().ids[0] as string;
    await until(() => fake.prompts.size === 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", done).executeTakeFirstOrThrow()).status === "done");
    // its record is written after the job is said done
    await t.services.queue.idle();
    const kept = await t.db.selectFrom("render_stats").select(["model_file", "work"]).executeTakeFirstOrThrow();
    const work = kept.work ?? 832 * 1216;
    const rows: RenderRow[] = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: kept.model_file, time_key: "steps=28",
      kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: 0, waited_ms: 0,
      total_ms: 20_000, load_ms: 1_000, sample_ms: 16_000, refine_ms: 0, finish_ms: 3_000, step_ms: 500, expected_ms: null,
      vram_peak: null, heat_peak: null, asset_id: null, work, machine_id: null, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, created_at: now(),
    }));
    await t.db.insertInto("render_stats").values(rows).execute();

    const one = await estimate(`draft=${draft.id}`);
    expect(one.ms).toBeGreaterThan(0);
    expect(one.basis).toBeGreaterThanOrEqual(4);
    const clipOne = (await estimate(`timeline=${tl.id}&clips=1`)).ms as number;
    // the draft renders twice; three clips are three renders; left out, the clips with nothing rendered yet
    expect(one.ms).toBe(clipOne * 2);
    expect((await estimate(`timeline=${tl.id}&clips=1,2,3`)).ms).toBe(clipOne * 3);
    expect((await estimate(`timeline=${tl.id}`)).ms).toBe(clipOne * 3);
    // a clip number past the end, or nothing to render, says nothing
    expect((await estimate(`timeline=${tl.id}&clips=9`)).ms).toBeNull();
    // the editor's own: each form it sends, the same forecast; null for what was never rendered here
    const each = (await post(t.app, "/api/forecasts", { forms: [{ recipe: "sdxl.text-to-picture", input: { checkpoint: CHECKPOINT } }, { recipe: "nope", input: {} }] })).json();
    expect(each.ms).toEqual([clipOne, null]);
    expect((await post(t.app, "/api/forecasts", { forms: "all" })).statusCode).toBe(400);

    await post(t.app, "/api/queue/pause");
    await post(t.app, "/api/jobs", job({ prompt: "Night market" }));
    expect((await estimate(`draft=${draft.id}`)).ahead).toBeGreaterThanOrEqual(1);

    expect((await get(t.app, "/api/command-estimate")).statusCode).toBe(400);
    expect((await get(t.app, `/api/command-estimate?timeline=${tl.id}&draft=${draft.id}`)).statusCode).toBe(400);
    expect((await get(t.app, "/api/command-estimate?timeline=nope")).statusCode).toBe(404);
    expect((await get(t.app, "/api/command-estimate?draft=nope")).statusCode).toBe(404);
  });
});

describe("the prompt history", () => {
  /** Render one picture with these words; its job id. */
  async function picture(prompt: string) {
    const before = fake.prompts.size;
    const id = (await post(t.app, "/api/jobs", job({ prompt }))).json().ids[0] as string;
    await until(() => fake.prompts.size === before + 1);
    complete(fake, [...fake.prompts.keys()].at(-1)!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    const gen = (await t.db.selectFrom("jobs").select("generation_id").where("id", "=", id).executeTakeFirstOrThrow()).generation_id!;
    return (await t.db.selectFrom("assets").select("id").where("generation_id", "=", gen).executeTakeFirstOrThrow()).id;
  }

  it("lists the prompts rendered, each once, newest first, with a picture still in the library, and searches them", async () => {
    await t.services.queue.start();
    const first = await picture("Harbor walk at dawn, gulls over the pier");
    await picture("Night market, lanterns and rain");
    const again = await picture("Harbor walk at dawn, gulls over the pier");
    await picture("A 100% \"quoted\" line_with_underscores");
    const history = async (qs = "") => (await get(t.app, `/api/prompt-history${qs}`)).json().items as Array<{ prompt: string; recipe: string; assetId: string | null; draftId: string | null; createdAt: string }>;

    const all = await history();
    expect(all.map((i) => i.prompt)).toEqual(["A 100% \"quoted\" line_with_underscores", "Harbor walk at dawn, gulls over the pier", "Night market, lanterns and rain"]);
    expect(all[1]).toMatchObject({ recipe: "sdxl.text-to-picture", assetId: again, draftId: null });
    // the newest render's picture binned: the one before it stands for the prompt
    await t.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", again).execute();
    expect((await history()).find((i) => i.prompt.startsWith("Harbor"))!.assetId).toBe(first);

    expect((await history("?q=HARBOR")).map((i) => i.prompt)).toEqual(["Harbor walk at dawn, gulls over the pier"]);
    expect((await history("?q=lanterns%20and")).map((i) => i.prompt)).toEqual(["Night market, lanterns and rain"]);
    // LIKE's own characters and JSON's escapes are searched as themselves
    expect((await history(`?q=${encodeURIComponent('100% "quoted"')}`))).toHaveLength(1);
    expect((await history("?q=e_w"))).toHaveLength(1);
    expect((await history("?q=%25"))).toHaveLength(1);
    expect((await history("?q=nothing-like-it"))).toEqual([]);
    expect((await history("?limit=1"))).toHaveLength(1);
    expect((await get(t.app, `/api/prompt-history?q=${"x".repeat(201)}`)).statusCode).toBe(400);
  });
});

describe("the command bar's settings", () => {
  it("default to Ctrl+K with every optional part off; a part of the bar not sent takes its default", async () => {
    const s = (await get(t.app, "/api/settings")).json();
    expect(s.bar).toEqual({ shortcut: "Ctrl+K", snippets: false, cast: false });
    const saved = await call("PUT", "/api/settings", { bar: { shortcut: "Ctrl+Shift+P", snippets: true, cast: false } });
    expect(saved.bar).toEqual({ shortcut: "Ctrl+Shift+P", snippets: true, cast: false });
    expect((await call("PUT", "/api/settings", { bar: { shortcut: "Alt+Space" } })).bar).toEqual({ shortcut: "Alt+Space", snippets: false, cast: false });
    const refused = async (patch: unknown) => (await t.app.inject({ method: "PUT", url: "/api/settings", payload: patch as object })).statusCode;
    expect(await refused({ bar: { shortcut: "Ctrl+ K" } })).toBe(400);
  });
});

describe("the command bar's search of the library", () => {
  it("lets through every item whose label the bar's own matching takes, unnamed ones by their kind", async () => {
    const labels = ["Harbor walk", "harbor_walk-04", "Night market · c2", "Pier at dawn", "Café crème", "ÉTÉ 2026", "100% real", "a_b", "Gulls (take 3)", "Über alles"];
    await put(...labels.map((name) => asset(null, { name })), asset(null, { kind: "video" }), asset(null, { kind: "audio" }), asset(null, { name: "binned walk", binned: true }));
    const all = [...labels, "Video", "Sound", "binned walk"];
    const typed = ["har", "walk harbor", "hw", "nm", "pier", "crème", "été", "café", "%", "_", "a_b", "100%", "gulls 3", "vid", "snd", "über", "BINNED", "hrbr", "c2", "x", "e e"];
    for (const q of typed) {
      const want = all.filter((l) => score(prepare(l), q.trim().toLowerCase()) > 0).sort();
      const got = (await items(q)).map((e) => e.label);
      // every label the bar would match comes back (a few more may: the bar sieves them again)
      expect({ q, missing: want.filter((l) => !got.includes(l)) }).toEqual({ q, missing: [] });
    }
    // what is typed as it is comes first, before a match of its letters
    expect((await items("walk"))[0]!.label).toMatch(/walk/i);
  });
});
