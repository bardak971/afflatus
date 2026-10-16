import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMoveTimelines } from "../../src/screens/studio/TimelineCards";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";

/** The selected timelines put in a folder (review S-12): a refusal is said, the others still move, the list is read again. */

describe("putting the selected timelines in a folder", () => {
  it("says how many were not moved, and reads the list again", async () => {
    fakeApi.on("PATCH /timelines/:id", ({ params }) => (params.id === "zz-test-b" ? jsonAnswer({ error: "zz-test folder of another project" }, 400) : { id: params.id }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMoveTimelines(), { wrapper });
    act(() => result.current.mutate({ ids: ["zz-test-a", "zz-test-b", "zz-test-c"], folder: "zz-test-folder" }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toEqual(["The timelines were not moved"]));
    expect(useBanners.getState().items[0]!.text).toBe("1 of 3 timelines not moved: zz-test folder of another project");
    expect(fakeApi.calls("PATCH", "/timelines/").map((c) => [c.path, c.body])).toEqual([
      ["/timelines/zz-test-a", { folder: "zz-test-folder" }],
      ["/timelines/zz-test-b", { folder: "zz-test-folder" }],
      ["/timelines/zz-test-c", { folder: "zz-test-folder" }],
    ]);
    await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: ["timelines"] }));
  });
});
