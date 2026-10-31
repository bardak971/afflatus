import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FirstLaunch } from "../../src/screens/FirstLaunch";
import { CapsCard } from "../../src/screens/settings/RentedCard";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

/**
 * The spending caps saved two in a row (money, useCapsSave): on the first launch and in Settings › Rented GPUs alike, a
 * second cap saved before the first one answers never sets the first back, and a cap refused is said and shown as saved.
 */

const own = { id: "m1", name: "", url: "http://127.0.0.1:8188", dir: "", takes: "all", packs: "ask", families: {}, tokenEnd: "" };
const settings = { machines: [own], hasRunpodKey: true, rentCaps: { day: 0, month: 0 }, allFamilies: true, comfyUrl: own.url, comfyDir: "", firstLaunch: "pending", volumeUnusedDays: 7, lastDeploy: null };

/** The settings' PUTs: the first one held until `first` is answered (with a value, or a Response), the others answered at once. */
function serveSaves() {
  let now: Record<string, unknown> = settings;
  const first = later<unknown>();
  let n = 0;
  fakeApi.on("GET /settings", () => now);
  fakeApi.on("PUT /settings", async ({ body }) => {
    const answer = n++ === 0 ? await first.promise : null;
    if (answer instanceof Response) return answer;
    now = { ...now, ...(body as object) };
    return now;
  });
  fakeApi.on("GET /setup/find", { found: null, tried: [own.url] });
  return first;
}

/** The first launch drawn on a ComfyUI already added (its settings read first), so that Done is there. */
async function drawAdded() {
  const drawn = draw(<FirstLaunch />);
  await drawn.client.prefetchQuery({ queryKey: ["settings"], queryFn: () => fetch("/api/settings").then((r) => r.json()) });
  drawn.rerender(<FirstLaunch key="read" />);
  await screen.findByRole("button", { name: "Done" });
  return drawn;
}

const bodies = () => fakeApi.calls("PUT", "/settings").map((c) => c.body);
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("the first launch's caps", () => {
  it("sends a month cap saved before the day's answers on top of the day cap, not on the caps of the last render", async () => {
    const first = serveSaves();
    const { user } = draw(<FirstLaunch />);
    await user.type(await screen.findByLabelText("Cap a day"), "5");
    await user.tab();
    await waitFor(() => expect(bodies()).toHaveLength(1));
    await user.type(box("Cap a month"), "40");
    await user.tab();
    first.answer(null);
    await waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies()).toEqual([{ rentCaps: { day: 5, month: 0 } }, { rentCaps: { day: 5, month: 40 } }]);
    await waitFor(() => expect(box("Cap a day").value).toBe("5"));
    expect(box("Cap a month").value).toBe("40");
  });

  it("says a refused cap, and shows it as saved rather than the amount typed", async () => {
    const first = serveSaves();
    const { user } = draw(<FirstLaunch />);
    await user.type(await screen.findByLabelText("Cap a day"), "5");
    await user.tab();
    first.answer(jsonAnswer({ error: "the settings could not be written" }, 500));
    expect(await screen.findByText(/The day cap was not saved \(still none\): the settings could not be written/)).toBeTruthy();
    expect(box("Cap a day").value).toBe("");
  });

  it("Done waits for a cap still saving, and closes the page once it is saved", async () => {
    const first = serveSaves();
    const { user } = await drawAdded();
    await user.type(await screen.findByLabelText("Cap a day"), "5");
    // the click leaves the box: its save goes first, Done after it
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(bodies()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies()).toEqual([{ rentCaps: { day: 5, month: 0 } }]);
    first.answer(null);
    await waitFor(() => expect(bodies()).toEqual([{ rentCaps: { day: 5, month: 0 } }, { firstLaunch: "done" }]));
  });

  it("Done stays on the page when the cap it waited for is refused, and says so", async () => {
    const first = serveSaves();
    const { user } = await drawAdded();
    await user.type(await screen.findByLabelText("Cap a day"), "5");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(bodies()).toHaveLength(1));
    first.answer(jsonAnswer({ error: "the settings could not be written" }, 500));
    expect(await screen.findByText(/The day cap was not saved \(still none\)/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies()).toEqual([{ rentCaps: { day: 5, month: 0 } }]);
    // pressed again, with the refusal said: the user leaves as they asked
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(bodies().at(-1)).toEqual({ firstLaunch: "done" }));
  });
});

describe("Settings › Costs' caps", () => {
  it("sends an edit queued behind a refused one without the refused value, and keeps saying that cap was not saved", async () => {
    const first = serveSaves();
    const { user } = draw(<CapsCard />);
    await user.type(await screen.findByLabelText("Cap a day"), "3");
    await user.tab();
    await waitFor(() => expect(bodies()).toHaveLength(1));
    await user.type(box("Cap a month"), "10");
    await user.tab();
    first.answer(jsonAnswer({ error: "the settings could not be written" }, 500));
    await waitFor(() => expect(bodies()).toHaveLength(2));
    // the day's $3 was refused: it is not in force, and the month's save does not bring it in
    expect(bodies()[1]).toEqual({ rentCaps: { day: 0, month: 10 } });
    await waitFor(() => expect(box("Cap a month").value).toBe("10"));
    expect(screen.getByText(/The day cap was not saved \(still none\)/)).toBeTruthy();
    expect(box("Cap a day").value).toBe("");
  });

  it("keeps a second edit of the same cap queued behind a refused one", async () => {
    const first = serveSaves();
    const { user } = draw(<CapsCard />);
    await user.type(await screen.findByLabelText("Cap a day"), "3");
    await user.tab();
    await waitFor(() => expect(bodies()).toHaveLength(1));
    await user.clear(box("Cap a day"));
    await user.type(box("Cap a day"), "4");
    await user.tab();
    first.answer(jsonAnswer({ error: "the settings could not be written" }, 500));
    await waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies()[1]).toEqual({ rentCaps: { day: 4, month: 0 } });
    // the day saved after: its note goes
    await waitFor(() => expect(screen.queryByText(/The day cap was not saved/)).toBeNull());
    await waitFor(() => expect(box("Cap a day").value).toBe("4"));
  });

  it("refuses a 0 and a cap in euros, says why, and saves nothing (0 would be no cap, €50 is not $50)", async () => {
    serveSaves();
    const { user } = draw(<CapsCard />);
    await user.type(await screen.findByLabelText("Cap a day"), "0");
    await user.tab();
    expect(await screen.findByText(/a cap is above \$0/)).toBeTruthy();
    await user.type(box("Cap a month"), "€50");
    await user.tab();
    expect(await screen.findByText(/caps are in US dollars/)).toBeTruthy();
    expect(bodies()).toHaveLength(0);
    expect(box("Cap a day").value).toBe("");
    expect(box("Cap a month").value).toBe("");
  });
});
