import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { changeAssets } from "../../src/assetChange";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";

/**
 * Redo off the timeline editor (review 4, P14): a move, a bin or a put back undone from its banner offers Redo, which
 * makes the change again and says it again with its Undo, so Ctrl+Z and Ctrl+Shift+Z walk back and forth.
 */

const newest = () => useBanners.getState().items.at(-1)!;

describe("a library change's Redo", () => {
  it("comes once the change is undone, and makes it again with its Undo", async () => {
    fakeApi.on("POST /assets/:id/restore", ({ params }) => ({ id: params.id }));
    fakeApi.on("DELETE /assets/:id", { ok: true });
    const client = new QueryClient();
    await changeAssets(client, { kind: "restore", ids: ["zz-test-a"] });
    expect(newest()).toMatchObject({ title: "Put back · 1 item", action: { label: "Undo", undo: true } });

    newest().action!.run();
    await waitFor(() => expect(newest()).toMatchObject({ title: "Undone", text: "Put back · 1 item", action: { label: "Redo", redo: true } }));
    expect(fakeApi.calls("DELETE", "/assets/zz-test-a")).toHaveLength(1);

    newest().action!.run();
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-a/restore")).toHaveLength(2));
    await waitFor(() => expect(newest()).toMatchObject({ title: "Put back · 1 item", action: { label: "Undo", undo: true } }));
  });
});
