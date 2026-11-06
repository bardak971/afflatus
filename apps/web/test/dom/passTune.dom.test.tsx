import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { RANDOM_SEED } from "@afflatus/core";
import type { RecipeInfo } from "../../src/api";
import { useTune } from "../../src/passTune";
import { queryKeys } from "../../src/queryKeys";
import { useSendJob } from "../../src/queueVariation";
import { TunePopoverHost } from "../../src/TunePopover";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** A pass's popover (card #270): its rows filled from the picture, changed, then queued; ×N sent as one job of N copies. */

const sharper = {
  id: "zz-test.sharper", family: "zz-test", output: "image", op: "upscale", title: "Upscale",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "upscaler", type: "choice", label: "Upscaler", choices: ["zz-test-2x.pth", "zz-test-4x.pth"], default: "zz-test-4x.pth" },
    { id: "factor", type: "number", label: "Upscale by", min: 1.5, max: 4, step: 0.5, default: 2, unit: "×" },
  ],
} as unknown as RecipeInfo;
const redraw = {
  id: "zz-test.redraw", family: "zz-test", output: "image", op: "img2img", title: "img2img",
  inputs: [{ id: "source", type: "image", role: "source", label: "Image" }, { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 1, step: 0.05, default: 0.55 }, { id: "seed", type: "seed", label: "Seed" }],
} as unknown as RecipeInfo;
const at = { left: 100, top: 100, width: 120, height: 30 };

const ready = (client: ReturnType<typeof draw>["client"]) => {
  client.setQueryData(queryKeys.setup(), { comfy: { online: true }, recipes: [sharper, redraw].map((r) => ({ id: r.id, ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {} })) });
  client.setQueryData(queryKeys.modelSettings(), { items: [] });
};

describe("a pass's popover", () => {
  it("starts on the picture's values, and queues with the rows changed", async () => {
    const queue = vi.fn();
    const { client, user } = draw(<TunePopoverHost />);
    ready(client);
    act(() => useTune.getState().open(at, { action: "upscale", title: "Upscale 2x", job: { recipe: sharper, stored: { source: "zz-test-pic", factor: 3 }, label: "Upscale 2x" }, queue }));
    const factor = await screen.findByRole("slider", { name: "Upscale by" });
    // the picture's own factor, not the recipe's 2
    expect(factor.getAttribute("aria-valuenow")).toBe("3");
    factor.focus();
    await user.keyboard("{ArrowRight}");
    expect(factor.getAttribute("aria-valuenow")).toBe("3.5");
    // the same rows in the same words as the form: no batch count on a pass made once
    expect(screen.queryByRole("slider", { name: "Batch count" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Queue/ }));
    expect(queue).toHaveBeenCalledWith({ factor: 3.5 }, 1);
    expect(useTune.getState().ask).toBeNull();
  });

  it("has a batch count for Vary, sent as one job of that many copies on new seeds", async () => {
    fakeApi.on("POST /jobs", { ids: ["j1", "j2", "j3", "j4"] });
    let send: ReturnType<typeof useSendJob> | undefined;
    function Sender() {
      send = useSendJob();
      return null;
    }
    const { client, user } = draw(<><TunePopoverHost /><Sender /></>);
    ready(client);
    const job = { recipe: redraw, stored: { source: "zz-test-pic", strength: 0.3, seed: RANDOM_SEED }, label: "Vary subtle", from: "zz-test-pic" };
    act(() => useTune.getState().open(at, { action: "vary-subtle", title: "Vary subtle", job, queue: (changed, count) => void send!({ ...job, stored: { ...job.stored, ...changed }, count }) }));
    expect((await screen.findByRole("slider", { name: "Denoising strength" })).getAttribute("aria-valuenow")).toBe("0.3");
    const count = screen.getByRole("slider", { name: "Batch count" });
    count.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    await user.click(screen.getByRole("button", { name: /^Queue ×4/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/jobs")[0]!.body).toMatchObject({ recipe: "zz-test.redraw", count: 4, input: { source: "zz-test-pic", strength: 0.3, seed: RANDOM_SEED } });
  });
});
