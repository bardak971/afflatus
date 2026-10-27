import { beforeEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { kitUndone, undone, useAgentEdits, type DraftEdit, type KitEdit } from "../../src/agentEdits";
import type { Clip, Draft, Entity } from "../../src/api";
import { useDraft } from "../../src/draft";
import { useBanners, useOpenDraft } from "../../src/store";
import { useClipEdits } from "../../src/timeline/useClipEdits";
import { fakeApi, later } from "./fakeApi";
import { draw } from "./render";

/**
 * An agent's change and the user's typing at the same moment (card #134): a save of the page's that was out while the
 * agent's change was written, or written after it, does not leave it undone on the server; the toast's Undo puts back only
 * what still holds the agent's value. The server is fakeApi; nothing renders.
 */

const FORM = "zz-test.text";
const draft = (forms: Draft["forms"] = { [FORM]: { prompt: "as saved", steps: 20 } }, updatedAt = "2026-10-27T12:00:00.000Z"): Draft => ({
  id: "zz-test-d1", recipe: FORM, title: "", name: null, updatedAt, empty: false, projectId: null, forms, count: 1, look: null, chat: [], designer: null,
});
const edit = (over: Partial<DraftEdit> = {}): DraftEdit => ({
  id: "zz-test-d1", by: "Claude Code", token: "t1", at: "2026-10-27T12:00:00Z",
  fields: [{ form: FORM, input: "cfg", had: false, now: 6 }],
  ...over,
});

/** The open draft over fakeApi: each PUT answered with what it sent, saved at the time `stamp` gives it, after `hold`. */
function rig(o: { hold?: (n: number) => Promise<unknown> | undefined; stamp?: (n: number) => string } = {}) {
  useOpenDraft.getState().open("zz-test-d1");
  fakeApi.on("GET /drafts", () => ({ items: [draft()], unused: 0 }));
  fakeApi.on("GET /drafts/:id", () => draft());
  let n = 0;
  fakeApi.on("PUT /drafts/:id", async ({ body }) => {
    const k = ++n;
    await o.hold?.(k);
    return { ...draft(), ...(body as object), updatedAt: o.stamp?.(k) ?? `2026-10-27T12:00:0${k}.000Z` };
  });
  let d!: ReturnType<typeof useDraft>;
  function Create() {
    d = useDraft(FORM);
    return null;
  }
  draw(<Create />);
  return () => d;
}

const puts = () => fakeApi.calls("PUT", "/drafts/zz-test-d1").map((c) => (c.body as Draft).forms[FORM]);
const newest = () => useBanners.getState().items.at(-1);

beforeEach(() => {
  useAgentEdits.setState({ seq: 0, last: null, recent: [], rings: {} });
  useBanners.setState({ items: [] });
});

describe("an agent's edit of the open draft while the page saves (D1)", () => {
  it("heard while a save is out: what the page holds, the edit in it, is saved again after it", async () => {
    const first = later();
    const d = rig({ hold: (k) => (k === 1 ? first.promise : undefined) });
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => d().setValue(FORM, "prompt", "typed"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    // written on the server while the page's save was on its way: that save, written after, put the form back without it
    act(() => useAgentEdits.getState().heard(edit({ saved: "2026-10-27T12:00:00.500Z" })));
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "typed", steps: 20, cfg: 6 });
    act(() => first.answer(undefined));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).toEqual({ prompt: "typed", steps: 20, cfg: 6 });
    await act(() => new Promise((go) => setTimeout(go, 700)));
    expect(puts()).toHaveLength(2);
    expect(d().saving).toBe("saved");
  });

  it("heard after a save the server wrote later than it: saved again; one written before it: nothing sent", async () => {
    const d = rig();
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => d().setValue(FORM, "prompt", "typed"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(d().saving).toBe("saved"));
    // the page's save was written at 12:00:01, after the agent's at 12:00:00.5: the agent's change is undone on the server
    act(() => useAgentEdits.getState().heard(edit({ saved: "2026-10-27T12:00:00.500Z" })));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).toEqual({ prompt: "typed", steps: 20, cfg: 6 });
    await waitFor(() => expect(d().saving).toBe("saved"));
    // written after the page's last save (12:00:02): the server has it, nothing to send
    act(() => useAgentEdits.getState().heard(edit({ fields: [{ form: FORM, input: "steps", had: true, was: 20, now: 30 }], saved: "2026-10-27T12:00:09.000Z" })));
    expect(d().draft!.forms[FORM]).toMatchObject({ steps: 30 });
    await act(() => new Promise((go) => setTimeout(go, 700)));
    expect(puts()).toHaveLength(2);
  });
});

describe("the toast's Undo of an agent's draft edit (D4)", () => {
  it("puts back only what still holds the agent's value, and says what it kept", async () => {
    const d = rig();
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => useAgentEdits.getState().heard(edit({
      fields: [{ form: FORM, input: "prompt", had: true, was: "as saved", now: "a lighthouse" }, { form: FORM, input: "cfg", had: false, now: 6 }],
      count: { was: 1, now: 3 },
    })));
    const toast = newest()!;
    // the user types over one of the agent's fields
    act(() => d().setValue(FORM, "prompt", "the user's own words"));
    act(() => toast.action!.run());
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "the user's own words", steps: 20 });
    expect(d().draft!.count).toBe(1);
    expect(newest()).toMatchObject({ title: "Claude Code's change undone, in part", text: "One field was changed again since: it stays as it is now." });
    await waitFor(() => expect(puts().at(-1)).toEqual({ prompt: "the user's own words", steps: 20 }));
  });

  it("works from the copy the helpers are given: a field changed since, or taken out, stays", () => {
    const e = edit({ fields: [{ form: FORM, input: "prompt", had: true, was: "old", now: "agent" }, { form: FORM, input: "seed", had: true, was: 1, gone: true }], recipe: { was: "zz-test.a", now: FORM } });
    const typedOver = undone(draft({ [FORM]: { prompt: "newer", seed: 9 } }), e);
    expect(typedOver.kept).toBe(2);
    expect(typedOver.draft.forms[FORM]).toEqual({ prompt: "newer", seed: 9 });
    expect(typedOver.draft.recipe).toBe("zz-test.a");
    const untouched = undone(draft({ [FORM]: { prompt: "agent" } }), e);
    expect(untouched).toMatchObject({ kept: 0, draft: { forms: { [FORM]: { prompt: "old", seed: 1 } } } });
  });

  it("of a kit item: a part or a name changed since stays", () => {
    const item = { id: "zz-test-p", kind: "person", name: "zz-test Ann B", def: { tags: "newer", sentence: "agent" }, updatedAt: "" } as unknown as Entity;
    const e: KitEdit = { id: "zz-test-p", kind: "person", by: "Claude Code", token: "t1", at: "", fields: [{ key: "tags", had: true, was: "old", now: "agent" }, { key: "sentence", had: false, now: "agent" }], name: { was: "zz-test Ann", now: "zz-test Ann B" } };
    const r = kitUndone(item, e);
    expect(r.kept).toBe(1);
    expect(r.item.name).toBe("zz-test Ann");
    expect(r.item.def).toEqual({ tags: "newer" });
  });
});

describe("an agent's change to a clip's form while the editor holds typing over it (D2)", () => {
  const clip = { id: "zz-test-c1", kind: "video", recipe: "zz-test.video", inputs: { description: "as saved" } } as unknown as Clip;

  function editor() {
    let e!: ReturnType<typeof useClipEdits>;
    function Editor() {
      e = useClipEdits({
        timeline: undefined, clips: [clip], comfyOnline: true,
        recipes: { data: undefined } as never, setup: { data: undefined, isSuccess: false } as never, settings: { data: undefined } as never,
      });
      return null;
    }
    draw(<Editor />);
    return () => e;
  }

  it("lays the agent's values over what is typed, and saves it again after a save that was out", async () => {
    const first = later();
    let n = 0;
    fakeApi.on("PATCH /clips/:id", async () => (++n === 1 ? (await first.promise, {}) : {}));
    const e = editor();
    act(() => e().editInputs(clip, { description: "typed by the user" }));
    await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/zz-test-c1")).toHaveLength(1));
    // the agent sets the seed while that save is out: the save, written after, put the form back without it
    act(() => e().agentLaid("zz-test-c1", { description: "as saved" }, { description: "as saved", seed: 7 }));
    expect(e().inputsOf(clip)).toEqual({ description: "typed by the user", seed: 7 });
    act(() => first.answer(undefined));
    await waitFor(() => expect(fakeApi.calls("PATCH", "/clips/zz-test-c1")).toHaveLength(2));
    expect(fakeApi.calls("PATCH", "/clips/zz-test-c1")[1]!.body).toEqual({ inputs: { description: "typed by the user", seed: 7 } });
  });

  it("leaves a clip with nothing typed over it to the timeline read back", async () => {
    fakeApi.on("PATCH /clips/:id", {});
    const e = editor();
    act(() => e().agentLaid("zz-test-c1", { description: "as saved" }, { description: "as saved", seed: 7 }));
    await act(() => new Promise((go) => setTimeout(go, 700)));
    expect(fakeApi.calls("PATCH", "/clips/zz-test-c1")).toHaveLength(0);
  });
});
