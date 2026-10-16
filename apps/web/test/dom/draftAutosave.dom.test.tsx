import { beforeAll, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import type { Draft } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { useDraft } from "../../src/draft";
import { loadConfirmDialog } from "../../src/lazyParts";
import { useTreeActions } from "../../src/projects/useTreeActions";
import type { Row } from "../../src/projects/tree";
import { useOpenDraft } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

const draft = (id: string): Draft => ({
  id, recipe: "zz-test.text", title: "", name: null, target: "new", updatedAt: "", empty: false, projectId: null,
  forms: { "zz-test.text": { prompt: "as saved" } }, count: 1, look: null, chat: [], designer: null,
});

/** The Create form's open draft and the Projects panel's actions, drawn together, on the draft `first`. */
function rig(first: string) {
  useOpenDraft.getState().open(first);
  let d!: ReturnType<typeof useDraft>;
  let tree!: ReturnType<typeof useTreeActions>;
  function Create() {
    d = useDraft("zz-test.text");
    tree = useTreeActions();
    return null;
  }
  const drawn = draw(<><Create /><ConfirmHost /></>);
  return { d: () => d, tree: () => tree, ...drawn };
}

/** The drafts the server has, read and listed; each asked for by id. */
function answerDrafts(ids: string[]) {
  fakeApi.on("GET /drafts", () => ({ items: ids.map(draft), unused: 0 }));
  fakeApi.on("GET /drafts/:id", ({ params }) => (ids.includes(params.id!) ? draft(params.id!) : jsonAnswer({ error: "this draft was not found" }, 404)));
}

describe("the open draft's save", () => {
  beforeAll(() => loadConfirmDialog());

  it("says saved once the draft, gone from the server, is made again with what was typed", async () => {
    answerDrafts(["zz-test-d1"]);
    fakeApi.on("PUT /drafts/:id", () => jsonAnswer({ error: "this draft was not found" }, 404));
    fakeApi.on("POST /drafts", ({ body }) => ({ ...draft("zz-test-d2"), ...(body as object) }));
    const { d } = rig("zz-test-d1");
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => d().setValue("zz-test.text", "prompt", "typed just now"));
    await waitFor(() => expect(fakeApi.calls("POST", "/drafts")).toHaveLength(1));
    expect((fakeApi.calls("POST", "/drafts")[0]!.body as Draft).forms).toEqual({ "zz-test.text": { prompt: "typed just now" } });
    await waitFor(() => expect(d().saving).toBe("saved"));
  });

  it("of a draft deleted from the Projects panel is let go: not sent again, which made the draft again, nor said failed", async () => {
    answerDrafts(["zz-test-d1", "zz-test-d3"]);
    // the save is refused (a cast too large for the server), the delete goes through; after it the draft is not found
    let deleted = false;
    fakeApi.on("PUT /drafts/:id", () => (deleted ? jsonAnswer({ error: "this draft was not found" }, 404) : jsonAnswer({ error: "zz-test refused" }, 400)));
    fakeApi.on("DELETE /drafts/:id", () => ((deleted = true), { ok: true }));
    fakeApi.on("POST /drafts", ({ body }) => ({ ...draft("zz-test-d2"), ...(body as object) }));
    const { d, tree, user, unmount } = rig("zz-test-d1");
    await waitFor(() => expect(d().draft?.id).toBe("zz-test-d1"));
    act(() => d().setValue("zz-test.text", "prompt", "typed just now"));
    await waitFor(() => expect(d().saving).toBe("failed"));

    const row = { key: "dr:zz-test-d1", kind: "draft", id: "zz-test-d1", label: "zz-test draft", meta: "", bytes: null, depth: 0 } as Row;
    let removed!: Promise<void>;
    act(() => {
      removed = tree().remove([row]);
    });
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await act(() => removed);
    expect(fakeApi.calls("DELETE", "/drafts/zz-test-d1")).toHaveLength(1);
    await waitFor(() => expect(d().saving).toBe("saved"));

    // Retry, and the form left: nothing is sent for the deleted draft, and it is not made again
    const puts = fakeApi.calls("PUT", "/drafts/zz-test-d1").length;
    act(() => d().retry());
    unmount();
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(fakeApi.calls("PUT", "/drafts/zz-test-d1")).toHaveLength(puts);
    expect(fakeApi.calls("POST", "/drafts")).toHaveLength(0);
  });
});
