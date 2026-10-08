import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft, Entity, RecipeInfo } from "../src/api";
import { putDraft, remade, saveBodyOf } from "../src/draft";
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
  it("outlives the page when asked to (a save as the tab closes)", async () => {
    const asked = answers({ status: 200, body: draft });
    await putDraft("d1", saveBodyOf(draft), true);
    expect(asked[0]!.init.keepalive).toBe(true);
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
