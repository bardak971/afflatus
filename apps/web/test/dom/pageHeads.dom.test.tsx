import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { FamilyInfo, HistoryJob, RecipeInfo, RecipeStatus } from "../../src/api";
import { Workflows } from "../../src/screens/Workflows";
import { FailedRow } from "../../src/screens/queue/FailedRow";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The screens pass of review 4 (P1 outside the timeline, P9, P15): the Workflows page heads with the one PageHeader and
 * says a family whose files are not fetched yet in the neutral colour, as Settings › Models does; a failed job's ··· has
 * a column of its own at the end of the Queue's rows, not the Took one.
 */

const status = (id: string, over: Partial<RecipeStatus> = {}): RecipeStatus => ({ id, ready: false, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {}, ...over });
const recipe = (id: string, family: string): RecipeInfo => ({ id, family, version: 1, title: "txt2img", summary: "", output: "image", inputs: [], traits: null });
const family = (id: string, name: string): FamilyInfo => ({ id, name, summary: `${name} things.` }) as unknown as FamilyInfo;

describe("the Workflows page", () => {
  it("heads the page with its title, and says files to get in grey beside Get files, red only for what cannot run", async () => {
    fakeApi.on("GET /workflows", { items: [] });
    fakeApi.on("GET /recipes", { families: [family("krea", "Krea 2"), family("qwen", "Qwen Image"), family("sdxl", "SDXL")], recipes: [recipe("krea.t2i", "krea"), recipe("qwen.t2i", "qwen"), recipe("sdxl.t2i", "sdxl")] });
    fakeApi.on("GET /setup", {
      comfy: { online: true, url: "http://127.0.0.1:8188" },
      families: [],
      recipes: [status("krea.t2i", { missingFiles: ["a.safetensors", "b.safetensors"] }), status("qwen.t2i", { problems: ['3:1 KSampler: "beta57" is not a choice of "scheduler"'] }), status("sdxl.t2i", { ready: true })],
    });
    fakeApi.on("GET /settings", { machines: [] });
    draw(<Workflows />);
    const head = screen.getByRole("banner");
    expect(within(head).getByRole("heading", { level: 1, name: "Workflows" })).toBeTruthy();
    expect(head.className).toContain("h-14");
    expect(within(head).getByRole("button", { name: /Import ComfyUI workflow/ })).toBeTruthy();

    // not fetched yet: a count in the neutral colour, not "Not ready" in red (finding 1)
    const toGet = (await screen.findByText("2 files to get")).closest("span")!;
    expect(toGet.className).toContain("bg-hover");
    expect(toGet.className).not.toContain("bg-warn-wash");
    expect(screen.getByRole("button", { name: "Get files" })).toBeTruthy();
    // a graph ComfyUI would refuse is broken: that one stays red
    const broken = screen.getByText("Not ready").closest("span")!;
    expect(broken.className).toContain("bg-warn-wash");
    expect(screen.getByText("Ready")).toBeTruthy();
    // no workflow of the user's own: the empty state says how one comes in
    expect(screen.getByText("No workflow of your own yet")).toBeTruthy();
  });
});

describe("a failed job in the Queue's history", () => {
  it("puts its ··· in the last column, after When, with a dash under Took (finding 16)", () => {
    const job = { id: "j1", label: "zz-test picture", status: "failed", kind: "render", recipe: "sdxl.t2i", model: null, error: "Something broke.", finishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), draftId: null, prompt: "", seed: null, input: {}, made: [], batch: null, tookMs: null } as unknown as HistoryJob;
    draw(<FailedRow jobs={[job]} />);
    const row = screen.getByRole("button", { name: /zz-test picture: failed/ });
    const cells = [...row.children];
    expect(cells).toHaveLength(6);
    expect(within(cells[5] as HTMLElement).getByRole("button", { name: "More actions on zz-test picture" })).toBeTruthy();
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[4]!.textContent).toBe("just now");
  });
});
