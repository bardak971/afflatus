import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_ANSWERING, type Draft, type Entity, type RecipeInfo } from "../src/api";
import { inTurn, KEEPALIVE_MAX } from "../src/autosave";
import { closingBody, draftFate, pickFor, putDraft, remade, saveBodyOf } from "../src/draft";
import { presetRefusal } from "../src/screens/studio/PresetMenu";
import { copyText, localId } from "../src/secureContext";

const draft: Draft = {
  id: "d1", recipe: "sdxl.text", title: "", name: "Mine", target: "new", updatedAt: "", empty: false, projectId: "p1",
  forms: { "sdxl.text": { prompt: "a cat" } }, count: 2, look: null, chat: [{ role: "user", content: "hi" }], designer: null,
};

/** fetch, answering each call in turn, with what was asked kept. */
function answers(...replies: Array<{ status: number; body: unknown }>) {
  const asked: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  return asked;
}
afterEach(() => vi.unstubAllGlobals());

describe("a draft saved", () => {
  it("says when the server no longer has it, rather than failing for ever", async () => {
    answers({ status: 404, body: { error: "this draft was not found" } });
    expect(await putDraft("d1", saveBodyOf(draft))).toBe("gone");
  });
  it("fails with the server's own words otherwise (a cast too large for it)", async () => {
    answers({ status: 400, body: { error: "too many people" } });
    await expect(putDraft("d1", saveBodyOf(draft))).rejects.toThrow("too many people");
  });
  it("goes through the app's one way of asking: a server away reads as such, a refusal keeps its status", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(putDraft("d1", saveBodyOf(draft))).rejects.toThrow(NOT_ANSWERING);
    answers({ status: 413, body: { error: "too large" } });
    await expect(putDraft("d1", saveBodyOf(draft))).rejects.toMatchObject({ message: "too large", status: 413 });
  });
  it("outlives the page when asked to (a save as the tab closes)", async () => {
    const asked = answers({ status: 200, body: draft });
    await putDraft("d1", saveBodyOf(draft), true);
    expect(asked[0]!.init.keepalive).toBe(true);
    expect((asked[0]!.init.headers as Record<string, string>)["X-Afflatus"]).toBe("1");
    expect(JSON.parse(String(asked[0]!.init.body))).toEqual({ recipe: "sdxl.text", forms: draft.forms, count: 2, look: null, chat: draft.chat, designer: null });
  });
  it("that is gone is made again with all the page holds of it, its conversation and its name included", async () => {
    const asked = answers({ status: 200, body: { ...draft, id: "d2", chat: [], name: null } }, { status: 200, body: { ...draft, id: "d2" } });
    const again = await remade(draft);
    expect(again.id).toBe("d2");
    expect(JSON.parse(String(asked[0]!.init.body))).toMatchObject({ recipe: "sdxl.text", forms: draft.forms, count: 2, project: "p1" });
    expect(asked[1]!.url).toBe("/api/drafts/d2");
    expect(JSON.parse(String(asked[1]!.init.body))).toEqual({ chat: draft.chat, designer: null, name: "Mine" });
  });
});

describe("a preset applied", () => {
  const preset = (recipe?: string) => ({ id: "x", kind: "preset", name: "Soft light", def: { recipe, inputs: {} } }) as unknown as Extract<Entity, { kind: "preset" }>;
  const all = [{ id: "sdxl.text" }] as RecipeInfo[];
  it("is refused when it is made for a model that is not here, rather than moving the draft onto it", () => {
    expect(presetRefusal(preset("gone.recipe"), all)).toMatch(/not installed/);
    expect(presetRefusal(preset("sdxl.text"), all)).toBeNull();
    expect(presetRefusal(preset(undefined), all)).toBeNull();
  });
});

describe("on a page that is not secure (the LAN address over http)", () => {
  it("copies through a hidden text box when there is no clipboard", async () => {
    const box = { value: "", style: {} as Record<string, string>, setAttribute() {}, select: vi.fn(), remove: vi.fn() };
    const exec = vi.fn(() => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { createElement: () => box, body: { appendChild: vi.fn() }, execCommand: exec });
    await copyText("1girl, red dress");
    expect(box.value).toBe("1girl, red dress");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(box.remove).toHaveBeenCalled();
  });
  it("makes ids without crypto.randomUUID, each its own", () => {
    const ids = new Set(Array.from({ length: 50 }, localId));
    expect(ids.size).toBe(50);
  });
});

describe("the open draft when the project looked at changes", () => {
  it("is kept in its own project, the Inbox, or while everything is looked at", () => {
    expect(draftFate("p1", "p1", "p1")).toBe("keep");
    expect(draftFate(null, "p1", "none")).toBe("keep");
  });
  it("is left for the project's own draft once another project is looked at", () => {
    expect(draftFate("p1", "p1", "p2")).toBe("leave");
    expect(draftFate("p1", null, "none")).toBe("leave");
    // opened before the project was remembered with it (an older page)
    expect(draftFate("p1", undefined, "p2")).toBe("leave");
  });
  it("is followed to its project when it was opened from another one", () => {
    expect(draftFate("p1", "p2", "p2")).toBe("follow");
    expect(draftFate(null, "p2", "p2")).toBe("follow");
  });
  it("opens the project on the draft last open in it, else its newest, never the one left", () => {
    const items = [{ id: "new" }, { id: "old" }];
    expect(pickFor(items, "old", "x")).toEqual({ id: "old" });
    expect(pickFor(items, "elsewhere", "x")).toEqual({ id: "new" });
    expect(pickFor(items, undefined, "new")).toEqual({ id: "old" });
    expect(pickFor([], "old", null)).toBeUndefined();
  });
});

describe("the saves of a draft", () => {
  it("go one after the other: a later one is sent once the one before is answered, failed or not", async () => {
    const turn = inTurn();
    const log: string[] = [];
    let release!: () => void;
    const first = turn(async () => {
      log.push("first sent");
      await new Promise<void>((r) => (release = r));
      log.push("first answered");
      throw new Error("refused");
    });
    const second = turn(async () => {
      log.push("second sent");
      return "saved";
    });
    await Promise.resolve();
    expect(log).toEqual(["first sent"]);
    release();
    await expect(first).rejects.toThrow("refused");
    expect(await second).toBe("saved");
    expect(log).toEqual(["first sent", "first answered", "second sent"]);
  });

  it("made as the page closes fits a request that outlives the page: without the conversation when it is too long", () => {
    expect(closingBody(draft)).toEqual(saveBodyOf(draft));
    const talky: Draft = { ...draft, chat: [{ role: "user", content: "x".repeat(KEEPALIVE_MAX) }] };
    const body = closingBody(talky)!;
    expect(body.chat).toBeUndefined();
    expect(body.forms).toEqual(talky.forms);
    // nothing fits: nothing is sent that way (the browser would refuse it whole)
    expect(closingBody({ ...talky, forms: { "sdxl.text": { prompt: "y".repeat(KEEPALIVE_MAX) } } })).toBeNull();
  });
});
