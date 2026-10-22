import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Asset } from "../../src/api";
import { useSelection } from "../../src/screens/studio/useSelection";
import { fakeApi } from "./fakeApi";

/**
 * The Studio grid's keys on what is ticked (review 4, P14): S keeps (or unkeeps what is all kept already), as the
 * viewer's S, and Backspace bins as Del does.
 */

const item = (id: string, kept = false) => ({ id, name: `zz-test ${id}`, kind: "image", kept, path: null }) as unknown as Asset;

function grid(items: Asset[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useSelection({ items, listKey: "zz-test", binned: false, off: false }), { wrapper });
}

describe("the grid's keys on the ticked items", () => {
  it("keeps with S, and unkeeps with S when every ticked item is kept", async () => {
    fakeApi.on("POST /assets/bulk", { changed: 2 });
    const loose = grid([item("a"), item("b")]);
    act(() => loose.result.current.setPicked(["a", "b"]));
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/bulk").map((c) => (c.body as { action: string }).action)).toEqual(["keep"]));
    const kept = grid([item("c", true), item("d", true)]);
    act(() => kept.result.current.setPicked(["c", "d"]));
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/bulk").map((c) => (c.body as { action: string }).action)).toEqual(["keep", "unkeep"]));
  });

  it("bins the ticked items with Backspace, as with Del", async () => {
    fakeApi.on("DELETE /assets/:id", { ok: true });
    const g = grid([item("a")]);
    act(() => g.result.current.setPicked(["a"]));
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(fakeApi.calls("DELETE", "/assets/a")).toHaveLength(1));
  });
});
