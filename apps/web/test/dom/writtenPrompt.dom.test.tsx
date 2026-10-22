import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { useWrittenPrompt } from "../../src/RecipeForm";
import { ClipForm } from "../../src/timeline/inspector/form";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

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

  // The hook was tested alone, so a timeline that stopped passing `given` would have gone unseen (review O-12): the
  // Inspector's clip form is drawn here, and what it asks for is read.
  it("is asked with the clip before by a timeline clip that carries on, and without it by one that does not", async () => {
    fakeApi.on("POST /form/prompt", { into: "description", text: "zz-test written" });
    const recipe = { id: "h3.motion", family: "h3", title: "Motion transfer", partsInto: "description", inputs: [{ id: "description", type: "prompt", label: "Prompt" }] } as unknown as RecipeInfo;
    const clip = { id: "c2", kind: "video", recipe: "h3.motion", look: null, inputs: {}, take: null } as unknown as Clip;
    const timeline = { id: "zz-test-timeline", look: null, clips: [clip] } as unknown as Timeline;
    const drawn = (carries: boolean) => (
      <ClipForm
        timeline={timeline} clip={clip} index={1} recipes={[recipe]} recipe={recipe} form={recipe} status={undefined as never}
        stored={{ look: "a red scarf" }} whole={null} before={undefined} after={undefined} take={null}
        opens={null} ends={null} carries={carries} lead={undefined} frameExtra={undefined}
        onRecipe={() => {}} onInputs={() => {}} onPatch={() => {}} onDesigner={() => {}}
      />
    );
    const asked = () => fakeApi.calls("POST", "/form/prompt").map((c) => (c.body as { input: Record<string, unknown> }).input);
    const one = draw(drawn(true));
    await waitFor(() => expect(asked()).toContainEqual({ look: "a red scarf", previous: true }));
    one.unmount();
    fakeApi.reset();
    fakeApi.on("POST /form/prompt", { into: "description", text: "zz-test written" });
    draw(drawn(false));
    await waitFor(() => expect(asked()).toContainEqual({ look: "a red scarf" }));
    expect(asked().some((i) => "previous" in i)).toBe(false);
  });
});
