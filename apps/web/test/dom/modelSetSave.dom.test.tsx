import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ModelSetsCard } from "../../src/screens/settings/ModelSetsCard";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * A Model set's changes saved in a row (Settings › Models, D3): a change the server refused is not carried into the next
 * one, and a name refused goes back in its box.
 */

const a = { file: "a.safetensors", folder: "loras" };
const b = { file: "b.safetensors", folder: "loras" };
const set = { id: "s1", name: "Set one", presets: [], files: [a, b], off: [], count: 2, bytes: 0, updatedAt: "2026-10-26T00:00:00Z" };
const listed = (f: { file: string; folder: string }) => ({ ...f, off: false, via: null, on: {} });

/** The set's saves: the first one refused, the others taken. */
function serve() {
  let n = 0;
  fakeApi.on("GET /model-sets", { items: [set] });
  fakeApi.on("GET /model-sets/:id/files", { items: [listed(a), listed(b)] });
  fakeApi.on("PUT /model-sets/:id", ({ body }) => (n++ === 0 ? jsonAnswer({ error: "the name is too long" }, 400) : { ...set, ...(body as object) }));
}

const saves = () => fakeApi.calls("PUT", "/model-sets/s1").map((c) => c.body);
const nameBox = () => screen.getByLabelText("The set's name") as HTMLInputElement;

async function openSet() {
  serve();
  const drawn = draw(<ModelSetsCard />);
  await drawn.user.click(await screen.findByText("Set one"));
  await screen.findByText("a.safetensors");
  return drawn;
}

describe("a Model set's changes", () => {
  it("keeps a file whose removal was refused in the rename that follows", async () => {
    const { user } = await openSet();
    await user.click(screen.getByLabelText("Take a.safetensors out"));
    await waitFor(() => expect(useBanners.getState().items.map((x) => x.title)).toEqual(["The set was not saved"]));
    await user.clear(nameBox());
    await user.type(nameBox(), "Renamed");
    await user.tab();
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toEqual({ name: "Renamed", presets: [], files: [a, b], off: [] });
  });

  it("puts a refused name back in its box, and the next change is sent under the name saved", async () => {
    const { user } = await openSet();
    await user.clear(nameBox());
    await user.type(nameBox(), "x".repeat(130));
    await user.tab();
    await waitFor(() => expect(nameBox().value).toBe("Set one"));
    await user.click(screen.getByLabelText("Take b.safetensors out"));
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toEqual({ name: "Set one", presets: [], files: [a], off: [] });
  });

  it("sends a change queued behind a refused one without the refused change", async () => {
    let first: (r: Response) => void = () => {};
    let n = 0;
    fakeApi.on("GET /model-sets", { items: [set] });
    fakeApi.on("GET /model-sets/:id/files", { items: [listed(a), listed(b)] });
    fakeApi.on("PUT /model-sets/:id", ({ body }) => (n++ === 0 ? new Promise<Response>((r) => (first = r)) : { ...set, ...(body as object) }));
    const { user } = draw(<ModelSetsCard />);
    await user.click(await screen.findByText("Set one"));
    await screen.findByText("a.safetensors");
    await user.click(screen.getByLabelText("Take a.safetensors out"));
    await waitFor(() => expect(saves()).toHaveLength(1));
    await user.click(screen.getByLabelText("Take b.safetensors out"));
    first(jsonAnswer({ error: "the set could not be written" }, 500));
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toEqual({ name: "Set one", presets: [], files: [a], off: [] });
  });
});
