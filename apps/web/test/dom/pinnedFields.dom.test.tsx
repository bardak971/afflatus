import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RecipeInfo } from "../../src/api";
import { Form } from "../../src/RecipeForm";
import { useParts } from "../../src/recipeForm/Part";
import { InterfaceTab } from "../../src/screens/settings/InterfaceTab";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Pinned fields (mock-pinned.html): a setting pinned from the right-click on its name shows on a Pinned card at the top of
 * the form, as a live copy of the one in its section; the pins are kept per model family in the settings, the H3 forms
 * sharing theirs; Settings › Interface forgets them all.
 */

const sdxl = {
  id: "zz-test.sdxl", family: "sdxl", title: "txt2img", output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 28, advanced: true },
    { id: "cfg", type: "number", label: "CFG scale", min: 1, max: 15, step: 0.5, default: 5, advanced: true },
    { id: "hires", type: "toggle", label: "Hires fix", default: false, advanced: true },
    { id: "hiresDenoise", type: "number", label: "Denoising", min: 0.1, max: 0.8, step: 0.05, default: 0.45, advanced: true, showWhen: "hires" },
  ],
} as unknown as RecipeInfo;

const h3 = (id: string, title: string) => ({
  id, family: "h3", title, output: "video",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "shot", type: "choice", label: "Shot", options: ["Any", "Wide", "Close-up"], default: "Any" },
  ],
}) as unknown as RecipeInfo;

/** A form whose values are kept as a draft keeps them: what is changed in one place is drawn in the other. */
function Draft({ recipe, start = {} }: { recipe: RecipeInfo; start?: Record<string, unknown> }) {
  const [stored, setStored] = useState<Record<string, unknown>>(start);
  return (
    <Form
      recipe={recipe} status={undefined} stored={stored}
      onChange={(id, v) => setStored((x) => ({ ...x, [id]: v }))}
      onClear={(ids) => setStored((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !ids.includes(k))))}
    />
  );
}

/** The settings as the server keeps them: a save is answered with what it makes of them. */
function settingsWith(pinnedFields: Record<string, string[]>) {
  let kept = { machines: [], pinnedFields };
  fakeApi.on("GET /settings", () => kept);
  fakeApi.on("PUT /settings", ({ body }) => (kept = { ...kept, ...(body as object) }));
}
const saved = () => fakeApi.calls("PUT", "/settings").map((c) => (c.body as { pinnedFields?: unknown }).pinnedFields);

/** A setting's name, as a right-click finds it: the row of the control of that name, at the given place (0: first drawn). */
const nameOf = (control: HTMLElement) => control.closest("[data-input-id], [data-pinned-input]")!.querySelector<HTMLElement>("[data-field-name]")!;
const pinnedCard = () => document.querySelector<HTMLElement>('[data-part="pinned"]');

describe("pinned fields", () => {
  // the folds change at once: what is drawn is looked at, not the fold's motion
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    useParts.setState({ open: { sampling: true, model: true } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("pins from a right-click on a setting's name, first in the form, and unpins from either copy", async () => {
    settingsWith({ h3: ["shot"] });
    const { user } = draw(<Draft recipe={sdxl} />);
    await waitFor(() => expect(screen.getByRole("slider", { name: "CFG scale" })).toBeTruthy());
    // no pins for this family: no card and nothing said about one
    expect(pinnedCard()).toBeNull();
    fireEvent.contextMenu(nameOf(screen.getByRole("slider", { name: "CFG scale" })), { button: 2, clientX: 40, clientY: 40 });
    const menu = await screen.findByRole("menu");
    // nothing changed yet: the reset is there, off
    expect(within(menu).getByRole("menuitem", { name: /Reset to the model's default/ }).hasAttribute("disabled")).toBe(true);
    await user.click(within(menu).getByRole("menuitem", { name: /Pin to the top/ }));
    // every family's pins are sent: the H3 forms' stay
    await waitFor(() => expect(saved().at(-1)).toEqual({ h3: ["shot"], sdxl: ["cfg"] }));
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    expect(document.querySelector("[data-part]")?.getAttribute("data-part")).toBe("pinned");
    expect(within(pinnedCard()!).getByText("Pinned · 1")).toBeTruthy();
    // the strip lists it first
    expect(screen.getByRole("button", { name: "Pinned" })).toBeTruthy();
    // the copy says where it lives; its section's own carries a pin
    expect(within(pinnedCard()!).getByText("· Sampling")).toBeTruthy();
    const [, own] = screen.getAllByRole("slider", { name: "CFG scale" });
    expect(within(nameOf(own!)).getByRole("img", { name: "Pinned" })).toBeTruthy();
    // unpinned from its section's copy: the card goes, and the family with it
    fireEvent.contextMenu(nameOf(own!), { button: 2, clientX: 40, clientY: 40 });
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Unpin/ }));
    await waitFor(() => expect(saved().at(-1)).toEqual({ h3: ["shot"] }));
    await waitFor(() => expect(pinnedCard()).toBeNull());
  });

  it("keeps one value in two places, its changed mark in both, and lists the pinned values when folded", async () => {
    settingsWith({ sdxl: ["cfg", "hiresDenoise", "steps"] });
    useParts.setState({ open: { sampling: true, pinned: true } });
    const { user } = draw(<Draft recipe={sdxl} start={{ steps: 34, hires: true }} />);
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    // in the order kept
    expect(within(pinnedCard()!).getAllByRole("slider").map((s) => s.getAttribute("aria-label"))).toEqual(["CFG scale", "Denoising", "Steps"]);
    const [pinned, own] = screen.getAllByRole("slider", { name: "CFG scale" });
    pinned!.focus();
    await user.keyboard("{ArrowRight}");
    expect(pinned!.getAttribute("aria-valuenow")).toBe("5.5");
    expect(own!.getAttribute("aria-valuenow")).toBe("5.5");
    // CFG and Steps changed, each in both places, and Hires fix in its section
    expect(screen.getAllByRole("button", { name: "Changed · reset" })).toHaveLength(5);
    // folded: its line says what is pinned, with the values
    await user.click(screen.getByRole("button", { name: "Pinned · 3: fold" }));
    expect(within(pinnedCard()!).getByText("CFG scale 5.5 · Denoising 0.45 · Steps 34")).toBeTruthy();
  });

  it("keeps a setting the form does not show now on the card, dimmed, saying why", async () => {
    settingsWith({ sdxl: ["hiresDenoise"] });
    useParts.setState({ open: { sampling: true, pinned: true } });
    draw(<Draft recipe={sdxl} />);
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    const row = pinnedCard()!.querySelector<HTMLElement>('[data-pinned-input="hiresDenoise"]')!;
    expect(within(row).getByText("· Hires fix is off")).toBeTruthy();
    const body = row.querySelector<HTMLElement>("[inert]")!;
    expect(body.className).toContain("opacity-50");
    // not in Sampling: the form does not show it there while Hires fix is off
    expect(screen.getAllByRole("slider", { name: "Denoising", hidden: true })).toHaveLength(1);
    // its grip still opens the menu, for Unpin
    fireEvent.contextMenu(within(row).getByRole("button", { name: /Move Denoising/ }), { button: 2, clientX: 40, clientY: 40 });
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Unpin/ })).toBeTruthy();
  });

  it("are kept per model family: a pin made on Video with audio shows on Lip sync, not on an SDXL form", async () => {
    settingsWith({ h3: ["shot"], sdxl: ["cfg"] });
    useParts.setState({ open: { pinned: true } });
    const lipsync = draw(<Draft recipe={h3("zz-test.h3.lipsync", "Lip sync")} />);
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    expect(within(pinnedCard()!).getByText("Pinned · 1")).toBeTruthy();
    expect(within(pinnedCard()!).getByText("Shot")).toBeTruthy();
    expect(within(pinnedCard()!).queryByRole("slider", { name: "CFG scale" })).toBeNull();
    lipsync.unmount();
    draw(<Draft recipe={sdxl} />);
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    expect(within(pinnedCard()!).getByRole("slider", { name: "CFG scale" })).toBeTruthy();
    expect(within(pinnedCard()!).queryByText("Shot")).toBeNull();
  });

  it("move with Alt + arrows on a pin's grip, the order kept for the family", async () => {
    settingsWith({ sdxl: ["cfg", "steps"] });
    useParts.setState({ open: { pinned: true } });
    const { user } = draw(<Draft recipe={sdxl} />);
    await waitFor(() => expect(pinnedCard()).toBeTruthy());
    within(pinnedCard()!).getByRole("button", { name: "Move Steps" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(saved().at(-1)).toEqual({ sdxl: ["steps", "cfg"] }));
  });

  it("are forgotten from Settings › Interface", async () => {
    settingsWith({ sdxl: ["cfg", "steps"], h3: ["shot"] });
    const { user } = draw(<InterfaceTab />);
    expect(await screen.findByText("3 fields pinned, over 2 model families")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(saved().at(-1)).toEqual({}));
    expect(await screen.findByText("None pinned")).toBeTruthy();
  });
});
