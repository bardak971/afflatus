import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { FamilyInfo, HistoryJob, RecipeInfo, RecipeStatus } from "../../src/api";
import { Workflows } from "../../src/screens/Workflows";
import { FailedRow } from "../../src/screens/queue/FailedRow";
import { PageHeader, Segmented } from "../../src/ui";
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

describe("a page header in a narrow window", () => {
  // No layout here: the header's row is as wide as the pieces still drawn in full (data-wide), against a page width.
  let pageWidth = 0;
  // the prototype that holds each width here, found from an element as the page makes them
  const owner = (key: string) => {
    for (let p: object | null = document.createElement("div"); p; p = Object.getPrototypeOf(p)) if (Object.getOwnPropertyDescriptor(p, key)) return p;
    throw new Error(`no ${key}`);
  };
  const kept: Array<[object, string, PropertyDescriptor]> = [];
  const stub = (key: string, get: (this: Element) => number) => {
    const p = owner(key);
    kept.push([p, key, Object.getOwnPropertyDescriptor(p, key)!]);
    Object.defineProperty(p, key, { configurable: true, get });
  };
  beforeEach(() => {
    // as a browser's does, the observer reports the size it finds as soon as it watches
    vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
    stub("scrollWidth", function () { return 600 + 200 * this.querySelectorAll("[data-wide]").length; });
    stub("clientWidth", () => pageWidth);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [p, key, d] of kept.splice(0)) Object.defineProperty(p, key, d);
  });
  const Head = () => (
    <PageHeader
      title="Settings"
      titleYields
      folds={2}
      after={<Segmented oneLine label="Views" value="a" onChange={() => {}} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }, { value: "c", label: "Three" }]} />}
      actions={(fold) => (
        <>
          {fold < 1 && <span data-wide>Notify when the queue is empty</span>}
          {fold < 2 ? <span data-wide>Pause all</span> : <span>II</span>}
        </>
      )}
    />
  );

  it("folds the actions a step at a time until the row fits, and keeps every tab and the title while it can", () => {
    pageWidth = 900;
    draw(<Head />);
    const head = screen.getByRole("banner");
    // 1000 wide at first: one step (the switch's words) is enough
    expect(within(head).queryByText("Notify when the queue is empty")).toBeNull();
    expect(within(head).getByText("Pause all")).toBeTruthy();
    expect(within(head).getAllByRole("radio")).toHaveLength(3);
    expect(within(head).getByRole("heading", { level: 1 }).className).not.toContain("sr-only");
  });

  it("past the last step lets the title go to screen readers and the tabs scroll, never drops a tab", () => {
    pageWidth = 500;
    draw(<Head />);
    const head = screen.getByRole("banner");
    expect(within(head).getByText("II")).toBeTruthy();
    expect(within(head).getAllByRole("radio")).toHaveLength(3);
    const title = within(head).getByRole("heading", { level: 1, name: "Settings" });
    expect(title.className).toContain("sr-only");
    expect(within(head).getByRole("radiogroup").parentElement!.className).toMatch(/\bshrink\b/);
  });
});
