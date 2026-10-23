import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { FindModels } from "../../src/FindModels";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

/**
 * Find models while a site is asked (card #56): skeleton cards before the first page, the cards there kept and dimmed
 * while another search is asked, who is slow past 3 s, and what failed with Try again, on Civitai's tab and Hugging Face's.
 */

const target = { what: "zz-test", action: "Add", add: () => {} };
const bases = { families: [{ id: "sdxl", name: "SDXL", on: true, bases: ["SDXL 1.0"], hf: [] }], types: ["LORA"], sorts: ["Most Downloaded"], periods: ["AllTime"] };
const card = (id: string, site: "civitai" | "huggingface" = "civitai") => ({
  site, id, name: `zz-test ${id}`, type: "LORA", base: "SDXL 1.0", creator: "zz", downloads: 1, likes: 0, updatedAt: null, thumb: null, page: "",
  licence: { commercial: null, credit: false, derivatives: null }, fits: null, have: false, update: null, gated: false, versions: [],
});

/** IntersectionObserver, which the drawn page does not have: never seeing anything (the next page is asked by hand). */
const noObserver = () => vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });

const skeletons = () => document.querySelectorAll("[data-skeleton]").length;

describe("Find models while a site is asked", () => {
  it("shows skeleton cards until Civitai's first page comes, then the cards", async () => {
    noObserver();
    fakeApi.on("GET /browse/bases", bases);
    const page = later<unknown>();
    fakeApi.on("GET /browse/civitai", () => page.promise);
    draw(<FindModels target={target} />);
    await waitFor(() => expect(skeletons()).toBe(8));
    expect(screen.getByRole("status", { name: "Asking Civitai" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Asking Civitai" })).toBeTruthy();
    await act(async () => page.answer({ items: [card("1")], next: null }));
    expect(await screen.findByText("zz-test 1")).toBeTruthy();
    expect(skeletons()).toBe(0);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps the cards there, dimmed, while another search is asked; never an empty grid", async () => {
    noObserver();
    fakeApi.on("GET /browse/bases", bases);
    const second = later<unknown>();
    // the handler sees no query: the second page asked is the search typed
    let n = 0;
    fakeApi.on("GET /browse/civitai", () => (++n > 1 ? second.promise : { items: [card("1")], next: null }));
    const { user } = draw(<FindModels target={target} />);
    await screen.findByText("zz-test 1");
    await user.type(screen.getByLabelText("Search Civitai"), "grain");
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Asking Civitai" })).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText("zz-test 1")).toBeTruthy();
    expect(screen.getByText("zz-test 1").closest(".grid")!.className).toContain("opacity-45");
    expect(skeletons()).toBe(0);
    await act(async () => second.answer({ items: [card("2")], next: null }));
    expect(await screen.findByText("zz-test 2")).toBeTruthy();
    expect(screen.queryByText("zz-test 1")).toBeNull();
  });

  it("says who is slow past 3 s, and what failed with Try again, on Hugging Face's tab", async () => {
    noObserver();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fakeApi.on("GET /browse/bases", bases);
      let fail = true;
      const slow = later<Response>();
      fakeApi.on("GET /browse/huggingface", () => (fail ? slow.promise : { items: [card("org/repo", "huggingface")], next: null }));
      const { user } = draw(<FindModels target={target} />);
      await user.click(await screen.findByRole("radio", { name: "Hugging Face" }));
      await waitFor(() => expect(skeletons()).toBe(8));
      expect(screen.queryByText(/slow to answer/)).toBeNull();
      await act(async () => vi.advanceTimersByTime(4000));
      expect(await screen.findByText(/Hugging Face is slow to answer · [34] s/)).toBeTruthy();
      await act(async () => slow.answer(jsonAnswer({ error: "Hugging Face did not answer in 20 s." }, 504)));
      expect(await screen.findByText("Hugging Face did not answer in 20 s.")).toBeTruthy();
      expect(screen.getByText(/Your models \(Yours\) and Civitai still work/)).toBeTruthy();
      expect(skeletons()).toBe(0);
      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("zz-test org/repo")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a row of skeletons where the next page lands, and says a failed one at the end with the cards kept", async () => {
    // the end of the list coming into view, said by hand as the observer would say it
    const seen: Array<(e: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { seen.push(cb); } observe() {} disconnect() {} });
    fakeApi.on("GET /browse/bases", bases);
    const more = later<Response>();
    let n = 0;
    fakeApi.on("GET /browse/civitai", () => (++n > 1 ? more.promise : { items: [card("1")], next: "c2" }));
    draw(<FindModels target={target} />);
    await screen.findByText("zz-test 1");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    act(() => { for (const said of seen) said([{ isIntersecting: true }]); });
    // the last row filled and a row more (4 columns where the grid's are not laid out: 3 + 4)
    await waitFor(() => expect(skeletons()).toBe(7));
    expect(screen.queryByRole("progressbar")).toBeNull();
    await act(async () => more.answer(jsonAnswer({ error: "Civitai did not answer in 20 s." }, 504)));
    expect(await screen.findByText("Civitai did not answer in 20 s.")).toBeTruthy();
    expect(screen.getByText("zz-test 1")).toBeTruthy();
    expect(skeletons()).toBe(0);
  });
});
