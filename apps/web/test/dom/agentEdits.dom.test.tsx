import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import type { Draft, RecipeInfo } from "../../src/api";
import { fieldKey, ringsOf, useAgentEdits, type DraftEdit } from "../../src/agentEdits";
import { useDraft } from "../../src/draft";
import { Form } from "../../src/RecipeForm";
import { useParts } from "../../src/recipeForm/Part";
import { useBanners, useOpenDraft } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A draft changed from outside by an MCP token (mock-0.8-mcp-v2.html, its right-hand column): the open form shows the change
 * at once, keeping what the user typed and has not saved; the app's toast says "<token> changed N fields" with Undo, which
 * puts the draft back as it was; the fields changed keep a quiet ring and the token's name until the user edits them.
 */

const FORM = "zz-test.text";
const draft = (id: string, forms: Draft["forms"] = { [FORM]: { prompt: "as saved", steps: 20 } }): Draft => ({
  id, recipe: FORM, title: "", name: null, updatedAt: "", empty: false, projectId: null, forms, count: 1, look: null, chat: [], designer: null,
});

const edit = (over: Partial<DraftEdit> = {}): DraftEdit => ({
  id: "zz-test-d1", by: "Claude Desktop", token: "t1", at: "2026-10-27T12:00:00Z",
  fields: [
    { form: FORM, input: "prompt", had: true, was: "as saved", now: "a lighthouse at dusk" },
    { form: FORM, input: "cfg", had: false, now: 6 },
  ],
  count: { was: 1, now: 3 },
  ...over,
});

function rig() {
  useOpenDraft.getState().open("zz-test-d1");
  fakeApi.on("GET /drafts", () => ({ items: [draft("zz-test-d1")], unused: 0 }));
  fakeApi.on("GET /drafts/:id", () => draft("zz-test-d1"));
  fakeApi.on("PUT /drafts/:id", ({ body }) => ({ ...draft("zz-test-d1"), ...(body as object) }));
  let d!: ReturnType<typeof useDraft>;
  function Create() {
    d = useDraft(FORM);
    return null;
  }
  draw(<Create />);
  return () => d;
}

const newest = () => useBanners.getState().items.at(-1);

beforeEach(() => {
  useAgentEdits.setState({ seq: 0, last: null, rings: {} });
  useBanners.setState({ items: [] });
});

describe("an MCP token's edit of the open draft", () => {
  it("shows at once, says who and how many in the toast, and Undo puts the draft back as it was", async () => {
    const d = rig();
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => useAgentEdits.getState().heard(edit()));
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "a lighthouse at dusk", steps: 20, cfg: 6 });
    expect(d().draft!.count).toBe(3);
    // already saved on the server: the page sends nothing for it
    await act(() => new Promise((go) => setTimeout(go, 700)));
    expect(fakeApi.calls("PUT", "/drafts/zz-test-d1")).toHaveLength(0);
    expect(newest()).toMatchObject({ title: "Claude Desktop changed 3 fields", action: { label: "Undo", undo: true } });
    expect(useAgentEdits.getState().rings["zz-test-d1"]).toEqual({ [fieldKey(FORM, "prompt")]: "Claude Desktop", [fieldKey(FORM, "cfg")]: "Claude Desktop" });
    act(() => newest()!.action!.run());
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "as saved", steps: 20 });
    expect(d().draft!.count).toBe(1);
    expect(useAgentEdits.getState().rings["zz-test-d1"]).toEqual({});
    // the undo is the user's own edit: saved as any other
    await waitFor(() => expect(fakeApi.calls("PUT", "/drafts/zz-test-d1")).toHaveLength(1));
    expect((fakeApi.calls("PUT", "/drafts/zz-test-d1")[0]!.body as Draft).forms[FORM]).toEqual({ prompt: "as saved", steps: 20 });
  });

  it("keeps what the user typed and has not saved yet, and takes the rest", async () => {
    const d = rig();
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => d().setValue(FORM, "prompt", "typed just now"));
    act(() => useAgentEdits.getState().heard(edit()));
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "typed just now", steps: 20, cfg: 6 });
    // the user's save carries the agent's other changes with what was typed
    await waitFor(() => expect(fakeApi.calls("PUT", "/drafts/zz-test-d1")).toHaveLength(1));
    expect((fakeApi.calls("PUT", "/drafts/zz-test-d1")[0]!.body as Draft).forms[FORM]).toEqual({ prompt: "typed just now", steps: 20, cfg: 6 });
  });

  it("of another draft only marks it to be read again: nothing changes on screen, no toast", async () => {
    const d = rig();
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => useAgentEdits.getState().heard(edit({ id: "zz-test-other" })));
    expect(d().draft!.forms[FORM]).toEqual({ prompt: "as saved", steps: 20 });
    expect(newest()).toBeUndefined();
  });
});

const recipe = {
  id: FORM, family: "sdxl", title: "txt2img", output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 28 },
    { id: "cfg", type: "number", label: "CFG scale", min: 1, max: 15, step: 0.5, default: 5 },
  ],
} as unknown as RecipeInfo;

/** The form as CreatePanel draws it: the rings of its draft, gone from a field the user edits. */
function Ringed() {
  const [stored, setStored] = useState<Record<string, unknown>>({ cfg: 6 });
  const rings = useAgentEdits((s) => s.rings["zz-test-d1"]);
  return (
    <Form
      recipe={recipe} status={undefined} stored={stored} agentRings={ringsOf(rings, FORM)}
      onChange={(id, v) => {
        useAgentEdits.getState().clear("zz-test-d1", [fieldKey(FORM, id)]);
        setStored((x) => ({ ...x, [id]: v }));
      }}
      onClear={() => {}}
    />
  );
}

describe("the ring of a field an MCP token changed", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    useParts.setState({ open: { sampling: true, model: true } });
    fakeApi.on("GET /settings", () => ({ machines: [], pinnedFields: {} }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("rings the field with the token's name after its own, until the user edits it", async () => {
    act(() => useAgentEdits.getState().heard(edit({ fields: [{ form: FORM, input: "cfg", had: false, now: 6 }], count: undefined })));
    const { user } = draw(<Ringed />);
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-input-id="cfg"]');
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row.dataset.agent).toBe("Claude Desktop");
    expect(row.className).toMatch(/ring-picture/);
    expect(row.textContent).toContain("· Claude Desktop");
    expect(document.querySelector('[data-input-id="steps"]')!.getAttribute("data-agent")).toBeNull();
    screen.getByRole("slider", { name: "CFG scale" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.querySelector('[data-input-id="cfg"]')!.getAttribute("data-agent")).toBeNull());
    expect(document.querySelector('[data-input-id="cfg"]')!.textContent).not.toContain("Claude Desktop");
  });
});
