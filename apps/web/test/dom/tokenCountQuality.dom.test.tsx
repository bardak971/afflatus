import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { InputSpec } from "@afflatus/core";
import type { FamilyInfo } from "../../src/api";
import { PromptField } from "../../src/fields/PromptField";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The CLIP token count under an SDXL prompt counts what the render is sent (card #300): the checkpoint's quality tags in
 * front of the prompt. Counted alone, a Pony preset's 30 tokens and a 60-token prompt said "60/75" and filled 90.
 */

const SDXL = { id: "sdxl" } as FamilyInfo;
const prompt = { id: "prompt", type: "prompt", label: "Prompt", style: "tags" } as Extract<InputSpec, { type: "prompt" }>;
const quality = { id: "quality", type: "prompt", label: "Quality tags", style: "tags", optional: true } as Extract<InputSpec, { type: "prompt" }>;
const asked = () => fakeApi.calls("POST", "/prompt/tokens").map((c) => (c.body as { text: string }).text);

describe("the token count of an SDXL prompt", () => {
  it("counts the quality tags with the prompt, once: the quality row has no count of its own", async () => {
    fakeApi.on("POST /prompt/tokens", ({ body }) => ({ chunks: [(body as { text: string }).text.split(",").length], exact: true }));
    const values = { prompt: "1girl, smile", quality: "score_9, score_8_up, " };
    draw(
      <>
        <PromptField spec={prompt} id="p" value={values.prompt} values={values} family={SDXL} onChange={() => {}} />
        <PromptField spec={quality} id="q" value={values.quality} values={values} family={SDXL} onChange={() => {}} />
      </>,
    );
    await waitFor(() => expect(asked()).toContain("score_9, score_8_up, 1girl, smile"));
    expect(await screen.findByText("4/75")).toBeTruthy();
    expect(asked().every((t) => t === "score_9, score_8_up, 1girl, smile")).toBe(true);
  });

  it("counts them in a Detail row's prompt too, which is sent after them (card #326)", async () => {
    fakeApi.on("POST /prompt/tokens", ({ body }) => ({ chunks: [(body as { text: string }).text.split(",").length], exact: true }));
    const face = { id: "detailFacePrompt", type: "prompt", label: "Face detail prompt", style: "tags", optional: true } as Extract<InputSpec, { type: "prompt" }>;
    const values = { prompt: "1girl", quality: "score_9, score_8_up, ", detailFacePrompt: "green eyes" };
    draw(<PromptField spec={face} id="f" value={values.detailFacePrompt} values={values} family={SDXL} onChange={() => {}} />);
    await waitFor(() => expect(asked()).toContain("score_9, score_8_up, green eyes"));
    expect(await screen.findByText("3/75")).toBeTruthy();
  });
});

describe("a wildcard file named in a prompt", () => {
  it("is said missing under it as it is written, before Render refuses it (card #318)", async () => {
    fakeApi.on("POST /prompt/wildcards", ({ body }) => ({ missing: (body as { text: string }).text.includes("__colors__") ? ["colors"] : [] }));
    const plain = { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" } as Extract<InputSpec, { type: "prompt" }>;
    draw(<PromptField spec={plain} id="p" value="a __colors__ dress" onChange={() => {}} />);
    expect(await screen.findByText("No wildcard file colors.txt: Render refuses it")).toBeTruthy();
    // a text with no name is not asked about
    expect(fakeApi.calls("POST", "/prompt/wildcards").every((c) => (c.body as { text: string }).text.includes("__"))).toBe(true);
  });
});
