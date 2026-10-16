import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Draft, RecipeInfo } from "../../src/api";
import type { useDraft } from "../../src/draft";
import { useGenerate } from "../../src/screens/studio/useGenerate";
import { useSeedMode } from "../../src/seedMode";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";

/**
 * Generate when the seed cannot be moved after the jobs were queued (review S-10: the draft switched during the round
 * trip, and its save refused): the jobs are queued, so Generate succeeds and the seed's failure is said on its own,
 * rather than Generate seeming to have failed and a second click queueing the same seeds again.
 */

const recipe = { id: "zz-test.text", inputs: [{ id: "prompt", type: "prompt", label: "Prompt" }, { id: "seed", type: "seed", label: "Seed" }] } as unknown as RecipeInfo;
const draft = { id: "zz-test-draft", count: 2, look: null, forms: { "zz-test.text": { prompt: "a glass bottle", seed: 41 } } } as unknown as Draft;

describe("Generate", () => {
  it("is done once the jobs are queued, and says a seed that could not be moved on its own", async () => {
    useSeedMode.setState({ mode: "up" });
    fakeApi.on("POST /jobs", { ids: ["j1", "j2"] });
    const d = { editDraft: () => Promise.reject(new Error("zz-test save refused")) } as unknown as ReturnType<typeof useDraft>;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useGenerate({ recipe, draft, defaults: {}, folder: undefined, d, blocked: null }), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1);
    const banner = useBanners.getState().items.find((b) => b.tone === "bad");
    expect(banner?.title).toBe("Queued; the seed was not moved to 43");
    expect(banner?.text).toBe("zz-test save refused");
  });
});
