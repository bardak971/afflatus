import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecipeInfo } from "../../src/api";
import { useWrittenPrompt } from "../../src/RecipeForm";
import { fakeApi } from "./fakeApi";

/**
 * The greyed "Prompt as sent" of a window that carries on (review H-3; then a Swap motion window, now Motion transfer's): the timeline gives the window its clip
 * before at plan time, not in the clip's own inputs, and the preview asked without it showed the swap's caption where the
 * render sends the motion's prompt.
 */
describe("the prompt as sent, written from the parts", () => {
  it("is asked with what the screen gives too: a window's clip before", async () => {
    fakeApi.on("POST /form/prompt", { into: "description", text: "The person carries on moving as in the clip before." });
    const recipe = { id: "h3.motion", partsInto: "description", inputs: [] } as unknown as RecipeInfo;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWrittenPrompt(recipe, { look: "a red scarf" }, { previous: true }), { wrapper });
    await waitFor(() => expect(result.current?.text).toBe("The person carries on moving as in the clip before."));
    expect(fakeApi.calls("POST", "/form/prompt").at(-1)?.body).toEqual({ recipe: "h3.motion", input: { look: "a red scarf", previous: true } });
  });
});
