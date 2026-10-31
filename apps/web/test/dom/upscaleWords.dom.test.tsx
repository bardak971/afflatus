import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InputSpec } from "@afflatus/core";
import { Field } from "../../src/fields";
import { draw } from "./render";

/**
 * The upscale routes said with Finish's words in a video form (card #172): the list shows "Upscale model", the value saved
 * stays the one older drafts and jobs hold ("Pixel: upscale model").
 */

const routes = { id: "upscale", type: "choice", label: "Upscale", default: "Off",
  options: ["Off", "Video: SeedVR2 (restores)", "Latent: re-sampled", "Pixel: RTX Video Super Resolution", "Pixel: upscale model"],
  labels: { "Video: SeedVR2 (restores)": "SeedVR2", "Latent: re-sampled": "Latent re-sample", "Pixel: RTX Video Super Resolution": "RTX Video Super Resolution", "Pixel: upscale model": "Upscale model" },
  details: { "Pixel: upscale model": "an ESRGAN-type model, frame by frame" } } as InputSpec;

function Upscale({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <Field spec={routes} value={value} options={undefined} onChange={(v) => setValue(String(v))} />
      <output aria-label="value">{value}</output>
    </>
  );
}

describe("a choice said in other words than its values", () => {
  it("shows the words and saves the value", async () => {
    const user = userEvent.setup();
    draw(<Upscale start="Latent: re-sampled" />);
    const list = screen.getByRole("button", { name: /Upscale/ });
    expect(list.textContent).toContain("Latent re-sample");
    expect(list.textContent).not.toContain("Latent: re-sampled");
    await user.click(list);
    await user.click(await screen.findByRole("option", { name: /Upscale model/ }));
    expect(screen.getByLabelText("value").textContent).toBe("Pixel: upscale model");
  });
});
