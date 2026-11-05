import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { DraftResults } from "../../src/screens/studio/DraftResults";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * K on the Stage (review 2026-11-05, #314): the version kept takes its original's place, and the Stage stays on it, even
 * while the draft's list, not read again yet, still has the original and not the kept one. It fell back to the list's
 * first item (another picture), which also ended Paint and fix.
 */

const picture = (id: string, createdAt: string) => ({ id, name: `zz-test ${id}`, kind: "image", mime: "image/png", width: 64, height: 48, createdAt, kept: false, inBin: false, generationId: null }) as unknown as Asset;
const other = picture("zz-test-other", "2026-11-05T10:00:00Z");
const head = picture("zz-test-head", "2026-11-05T09:00:00Z");
const v1 = { ...picture("zz-test-v1", "2026-11-05T09:30:00Z"), versionOf: head.id };

describe("the draft's Stage after K", () => {
  it("stays on the kept version while the list does not have it yet", async () => {
    fakeApi.on("GET /assets/:id/versions", ({ params }) => (params.id === other.id ? { head: other, versions: [] } : { head, versions: [v1] }));
    fakeApi.on("POST /assets/:id/versions/keep", { head: { ...v1, versionOf: null }, versions: [{ ...head, versionOf: v1.id }] });
    // the list as it was before the Keep, and as it stays in this test: the original in it, the kept version not
    const list = { items: [other, head], hasNextPage: false, more: () => {}, hasPreviousPage: false, newer: () => {}, loading: false, ready: true };
    draw(<DraftResults folder={undefined} list={list} />);
    const shown = () => document.querySelector<HTMLImageElement>("[data-stage] img")?.getAttribute("src") ?? "";
    fireEvent.click(await screen.findByRole("button", { name: `Open ${head.name}` }));
    await waitFor(() => expect(shown()).toContain(head.id));
    await screen.findByRole("group", { name: "Versions" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(shown()).toContain(v1.id));
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(fakeApi.calls("POST", `/assets/${head.id}/versions/keep`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(shown()).toContain(v1.id);
  });
});
