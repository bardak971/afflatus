import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { MachineState, QueueStatus } from "../../src/api";
import { Dot } from "../../src/machineBits";
import { Queue } from "../../src/screens/Queue";
import { MachineLanes } from "../../src/screens/queue/MachineLanes";
import { KwhForm } from "../../src/screens/settings/ElectricityCard";
import { beforeTone } from "../../src/screens/workflowEditor/BeforeItRuns";
import type { Mapping } from "../../src/screens/workflowEditor/useMapping";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The last open ends of review 4 (card #33): colours by role (red failed or broken, amber a look, neutral a to-do), a
 * field's error said in words, and the Queue's first launch led by its empty state.
 */

describe("the workflow editor's Before it can run", () => {
  const mapping = (found: Partial<Mapping["found"]>, looseNotes: string[] = []) =>
    ({ found: { missingNodes: [], missingFiles: [], missingChoices: [], packs: {}, ...found }, graph: { 7: { class_type: "UNETLoader", inputs: { unet_name: "zz-test.safetensors", sampler: "zz" } } }, looseNotes }) as unknown as Mapping;
  const file = { node: "7", input: "unet_name", file: "zz-test.safetensors", classType: "UNETLoader", label: "unet name", options: [] };

  it("is a neutral to-do when only files are left to download, red only for what ComfyUI would refuse", () => {
    expect(beforeTone(mapping({ missingFiles: [file] } as never))).toBe("todo");
    expect(beforeTone(mapping({ missingFiles: [file], missingNodes: ["ZzTestNode"] } as never))).toBe("broken");
    expect(beforeTone(mapping({ missingChoices: [{ node: "7", input: "sampler", value: "zz", title: "KSampler", options: [] }] } as never))).toBe("broken");
    expect(beforeTone(mapping({}, ["Length is counted at 16 fps."]))).toBe("attention");
    expect(beforeTone(mapping({}))).toBeNull();
  });
});

describe("the price a kWh", () => {
  it("says what is wrong under the field, and Save stays off with that reason", async () => {
    fakeApi.on("GET /settings", { machines: [], costs: { kwhPrice: null, currency: "€" } });
    const { user } = draw(<KwhForm />);
    const price = await screen.findByRole("textbox", { name: "Price a kWh" });
    await user.type(price, "abc");
    const said = screen.getByRole("alert");
    expect(said.textContent).toBe("Not a number: write the price as 0.25");
    expect(price.getAttribute("aria-describedby")).toBe(said.id);
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.getAttribute("data-tip")).toBe("Not a number: write the price as 0.25");
    await user.clear(price);
    await user.type(price, "250");
    expect(screen.getByRole("alert").textContent).toBe("A price a kWh is between 0 and 100");
    await user.clear(price);
    await user.type(price, "0.25");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the Queue on a first launch", () => {
  it("draws no history filters, search, model pick nor Pause with no machine and nothing done: the empty state leads", async () => {
    fakeApi.on("GET /settings", { machines: [], hasRunpodKey: false });
    fakeApi.on("GET /queue", { online: false, paused: false, running: null, waiting: [], later: [], recent: [], machines: [], tool: null });
    fakeApi.on("GET /jobs", { items: [], counts: { done: 0, failed: 0, cancelled: 0 }, more: false, next: null });
    draw(<Queue />);
    expect(await screen.findByText("Nothing finished yet")).toBeTruthy();
    expect(await screen.findByText("No machine yet", { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Which jobs" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText("Any model")).toBeNull();
    expect(screen.queryByRole("button", { name: /Pause queue/ })).toBeNull();
  });

  it("keeps them once there is a history, and the queue's switch once it is paused", async () => {
    fakeApi.on("GET /settings", { machines: [], hasRunpodKey: false });
    fakeApi.on("GET /queue", { online: false, paused: true, running: null, waiting: [], later: [], recent: [], machines: [], tool: null });
    fakeApi.on("GET /jobs", { items: [], counts: { done: 3, failed: 0, cancelled: 0 }, more: false, next: null });
    draw(<Queue />);
    expect(await screen.findByRole("radiogroup", { name: "Which jobs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume queue/ })).toBeTruthy();
  });
});

describe("a machine away", () => {
  const local = (over: Partial<MachineState> = {}): MachineState => ({ id: "m1", name: "Second GPU", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: false, locked: false, rented: null, model: null, pace: null, running: null, ...over }) as MachineState;
  const status = (machines: MachineState[]): QueueStatus => ({ online: true, paused: false, running: null, waiting: [], later: [], recent: [], machines, tool: null }) as unknown as QueueStatus;

  it("is amber, not red: it often comes back by itself; locked against Afflatus's token stays red", async () => {
    fakeApi.on("GET /settings", { hasRunpodKey: false, machines: [] });
    draw(<MachineLanes q={status([local(), local({ id: "m2", name: "Third GPU", locked: true })])} onStop={() => {}} onPin={() => {}} />);
    const away = await screen.findByRole("region", { name: "Second GPU" });
    expect(away.className).toContain("border-attention/35");
    expect(within(away).getByText("offline").className).toContain("text-attention-ink");
    expect(within(away).getByText(/not answering/).className).toContain("text-attention-ink");
    const locked = screen.getByRole("region", { name: "Third GPU" });
    expect(locked.className).toContain("border-warn/30");
    expect(within(locked).getByText("locked").className).toContain("text-warn-ink");

    const dot = draw(<Dot m={local()} />).container.querySelector("span")!;
    expect(dot.dataset.state).toBe("offline");
    expect(dot.className).toContain("bg-attention");
    expect(draw(<Dot m={local({ locked: true })} />).container.querySelector("span")!.className).toContain("bg-warn");
  });
});
