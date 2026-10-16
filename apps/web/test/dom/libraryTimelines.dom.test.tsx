import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLibraryFilters } from "../../src/screens/studio/useLibraryFilters";
import { fakeApi } from "./fakeApi";

/** The library's Timelines view (review S-17): the media pages are not fetched while the timelines' cards are shown. */

const view = { form: false, scope: "all" as const };

function drawFilters(initialKind: "all" | "timeline") {
  fakeApi.on("GET /assets", { items: [], next: null, prev: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useLibraryFilters({ place: { type: "all" }, view, draftId: null, initialKind }), { wrapper });
}

describe("the library's Timelines view", () => {
  it("fetches no media page while the timelines are shown", async () => {
    const { result } = drawFilters("timeline");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(result.current.showTimelines).toBe(true);
    expect(fakeApi.calls("GET", "/assets")).toHaveLength(0);
  });

  it("fetches them once the media are shown again", async () => {
    const { result } = drawFilters("timeline");
    act(() => result.current.setKind("all"));
    await waitFor(() => expect(fakeApi.calls("GET", "/assets").length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.assets.isSuccess).toBe(true));
  });
});
