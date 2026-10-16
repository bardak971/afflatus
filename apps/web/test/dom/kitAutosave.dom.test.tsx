import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Entity } from "../../src/api";
import { SnippetTable, type Snippet } from "../../src/screens/kit/SnippetTable";
import { useEntityDraft } from "../../src/screens/kit/useEntityDraft";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

const item = (id: string, name: string) => ({ id, kind: "preset", name, def: { inputs: {} } }) as unknown as Entity;

/** The Prompt kit's open item, drawn, with what it hands back kept for the test. */
function rig(first: Entity) {
  let d!: ReturnType<typeof useEntityDraft>;
  let open!: (e: Entity) => void;
  function Kit({ stored }: { stored: Entity }) {
    d = useEntityDraft({ stored, loading: false });
    return null;
  }
  const drawn = draw(<Kit stored={first} />);
  open = (e) => drawn.rerender(<Kit stored={e} />);
  return { d: () => d, open };
}

describe("the Prompt kit's items, edited one after another", () => {
  it("keeps a change whose save failed when another item is changed and saved", async () => {
    // the first item's saves are refused until the test lets them through; the second's go
    let refuse = true;
    const saved: string[] = [];
    fakeApi.on("PUT /entities/:id", ({ params, body }) => {
      if (params.id === "zz-test-a" && refuse) return jsonAnswer({ error: "zz-test refused" }, 500);
      saved.push(`${params.id} ${(body as { name: string }).name}`);
      return item(params.id!, (body as { name: string }).name);
    });
    const { d, open } = rig(item("zz-test-a", "A"));
    await waitFor(() => expect(d().edit?.id).toBe("zz-test-a"));
    act(() => d().change(item("zz-test-a", "A changed")));
    await act(() => d().flush());
    expect(d().saved).toBe("failed");

    // another item opened (its flush fails quietly) and changed: its save goes through
    open(item("zz-test-b", "B"));
    await waitFor(() => expect(d().edit?.id).toBe("zz-test-b"));
    act(() => d().change(item("zz-test-b", "B changed")));
    await act(() => d().flush());
    expect(saved).toEqual(["zz-test-b B changed"]);
    // the first item's change is still not saved, and said so
    expect(d().saved).toBe("failed");

    // opened again, it shows what was typed, not the server's copy; Retry sends it
    open(item("zz-test-a", "A"));
    await waitFor(() => expect(d().edit?.name).toBe("A changed"));
    refuse = false;
    await act(() => d().retry());
    expect(saved).toEqual(["zz-test-b B changed", "zz-test-a A changed"]);
    expect(d().saved).toBe("saved");
  });
});

describe("a snippet's text, typed in its row", () => {
  const snippet = { id: "zz-test-snippet", kind: "snippet", name: "zz-test snippet", def: { text: "as saved", category: "", style: null } } as unknown as Snippet;
  const table = () => <SnippetTable snippets={[snippet]} query="" only={null} onOnly={() => {}} fresh={null} />;
  const puts = () => fakeApi.calls("PUT", "/entities/zz-test-snippet").map((a) => (a.body as { def: { text: string } }).def.text);

  it("is saved when the row goes within a moment of the typing (the screen left)", async () => {
    fakeApi.on("PUT /entities/:id", ({ body }) => ({ ...snippet, ...(body as object) }));
    const { unmount } = draw(table());
    fireEvent.change(screen.getByLabelText("Text of zz-test snippet"), { target: { value: "typed just now" } });
    unmount();
    await waitFor(() => expect(puts()).toEqual(["typed just now"]));
  });

  it("goes by a request that outlives the page as the tab closes", async () => {
    fakeApi.on("PUT /entities/:id", ({ body }) => ({ ...snippet, ...(body as object) }));
    const { unmount } = draw(table());
    fireEvent.change(screen.getByLabelText("Text of zz-test snippet"), { target: { value: "typed just now" } });
    window.dispatchEvent(new Event("pagehide"));
    expect(fakeApi.calls("PUT", "/entities/zz-test-snippet").map((a) => a.body)).toEqual([{ name: "zz-test snippet", def: { text: "typed just now", category: "", style: null } }]);
    // the page stayed after all (a pagehide into the back-forward cache): the ordinary save still goes as the row goes
    unmount();
    await waitFor(() => expect(puts()).toHaveLength(2));
  });
});
