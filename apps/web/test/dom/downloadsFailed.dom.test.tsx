import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Download } from "../../src/api";
import { Banners } from "../../src/Banners";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Downloads that failed on a single-machine setup (the #143 audit, huggingface.co not answering): six files gave six sticky
 * banners following the user across pages, Swap's files among them. They are one banner now, their shared reason said once.
 */

const failed = (id: string): Download => ({ id, file: `${id}.safetensors`, folder: "diffusion_models", title: id, bytes: 0, total: 0, status: "error", error: "Could not reach huggingface.co.", via: "afflatus" });

describe("failed downloads into the one ComfyUI", () => {
  it("are one banner, not one per file", async () => {
    fakeApi.on("GET /settings", { machines: [{ id: "m1", url: "http://127.0.0.1:8188" }] });
    fakeApi.on("GET /queue", { running: [], waiting: [], machines: [] });
    fakeApi.on("GET /downloads", { on: true, items: ["unet", "clip", "videoVae", "audioVae", "swapUnet", "swapLora"].map(failed), manager: { found: false }, via: "afflatus" });
    draw(<Banners />);
    await waitFor(() => expect(useBanners.getState().items.filter((b) => b.tone === "bad")).toHaveLength(1));
    const banner = useBanners.getState().items.find((b) => b.tone === "bad")!;
    expect(banner.title).toBe("6 downloads failed");
    expect(banner.text).toMatch(/^Could not reach huggingface\.co: unet\.safetensors, clip\.safetensors/);
  });
});
