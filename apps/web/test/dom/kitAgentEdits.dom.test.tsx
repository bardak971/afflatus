import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "../../src/api";
import { kitLaidOver, kitUndone, useKitEdits, type KitEdit } from "../../src/agentEdits";
import { Card } from "../../src/Rows";
import { useEntityDraft } from "../../src/screens/kit/useEntityDraft";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * An item of the Prompt kit changed from outside by an MCP token (the server's mcpKit.ts, a "kit" live event), as a draft's
 * is: the kit open on it shows the change at once, keeping what the user typed and has not saved; the toast says
 * "<token> changed N fields" with Undo, which saves the item back as it was; the cards it changed are ringed with the
 * token's name until the user edits them.
 */

const person = (over: Partial<{ name: string; tags: string; sentence: string }> = {}): Entity => ({
  id: "zz-test-p1", kind: "person", name: over.name ?? "zz-test Ann", updatedAt: "",
  def: { pictures: [], voice: null, voicePart: null, tags: over.tags ?? "", sentence: over.sentence ?? "a woman", models: {}, outfits: [] },
});

const edit = (over: Partial<KitEdit> = {}): KitEdit => ({
  id: "zz-test-p1", kind: "person", by: "Claude Desktop", token: "t1", at: "2026-10-27T12:00:00Z",
  fields: [{ key: "sentence", had: true, was: "a woman", now: "a woman in a red coat" }],
  name: { was: "zz-test Ann", now: "zz-test Ann B" },
  ...over,
});

function rig(stored = person()) {
  const saved: unknown[] = [];
  fakeApi.on("PUT /entities/:id", ({ body }) => {
    saved.push(body);
    return { ...stored, ...(body as object) };
  });
  fakeApi.on("GET /entities", () => ({ items: [stored] }));
  let d!: ReturnType<typeof useEntityDraft>;
  function Kit() {
    d = useEntityDraft({ stored, loading: false });
    return null;
  }
  draw(<Kit />);
  return { d: () => d, saved };
}

const newest = () => useBanners.getState().items.at(-1);

beforeEach(() => {
  useKitEdits.setState({ seq: 0, last: null, rings: {} });
  useBanners.setState({ items: [] });
});

describe("an MCP token's edit of the kit item open", () => {
  it("shows at once, says who and how many, and Undo saves the item back as it was", async () => {
    const { d, saved } = rig();
    await waitFor(() => expect(d().edit?.id).toBe("zz-test-p1"));
    act(() => useKitEdits.getState().heard(edit()));
    expect(d().edit).toMatchObject({ name: "zz-test Ann B", def: { sentence: "a woman in a red coat" } });
    expect(newest()).toMatchObject({ title: "Claude Desktop changed 2 fields", action: { label: "Undo" } });
    // nothing is saved for the agent's change: the server has it already
    expect(saved).toEqual([]);
    act(() => newest()!.action!.run());
    expect(d().edit).toMatchObject({ name: "zz-test Ann", def: { sentence: "a woman" } });
    await act(() => d().flush());
    expect(saved.at(-1)).toMatchObject({ name: "zz-test Ann", def: { sentence: "a woman" } });
    // undone: its rings go
    expect(useKitEdits.getState().rings["zz-test-p1"]).toEqual({});
  });

  it("keeps what the user typed and has not saved, and their edit takes the ring off", async () => {
    const { d, saved } = rig();
    await waitFor(() => expect(d().edit?.id).toBe("zz-test-p1"));
    // the user types the tags; the agent changes the sentence and the tags before that is saved
    act(() => d().change(person({ tags: "short hair" })));
    act(() => useKitEdits.getState().heard(edit({ fields: [{ key: "sentence", had: true, was: "a woman", now: "a woman in a red coat" }, { key: "tags", had: true, was: "", now: "1girl" }] })));
    expect(d().edit!.def).toMatchObject({ tags: "short hair", sentence: "a woman in a red coat" });
    expect(useKitEdits.getState().rings["zz-test-p1"]).toMatchObject({ sentence: "Claude Desktop", name: "Claude Desktop" });
    act(() => d().change({ ...d().edit!, def: { ...(d().edit!.def as object), sentence: "a woman, typed" } } as Entity));
    expect(useKitEdits.getState().rings["zz-test-p1"]!.sentence).toBeUndefined();
    // the user's change and the agent's other parts go out together
    await act(() => d().flush());
    expect(saved.at(-1)).toMatchObject({ def: { tags: "short hair", sentence: "a woman, typed" } });
  });

  it("is laid over and undone part by part", () => {
    const e = edit({ fields: [{ key: "tags", had: false, now: "1girl" }] });
    const over = kitLaidOver(person(), e);
    expect(over).toMatchObject({ name: "zz-test Ann B", def: { tags: "1girl" } });
    expect((kitUndone(over, e).item.def as unknown as Record<string, unknown>).tags).toBeUndefined();
    expect(kitLaidOver(person(), e, new Set(["name"])).name).toBe("zz-test Ann");
  });
});

describe("a card an MCP token changed", () => {
  it("is ringed with the token's name after its title", () => {
    draw(<Card dense title="Prompt text" by="Claude Desktop">x</Card>);
    expect(screen.getByText("· Claude Desktop")).toBeTruthy();
    expect(document.querySelector("[data-agent='Claude Desktop']")).toBeTruthy();
  });
});
