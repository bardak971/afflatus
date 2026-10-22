import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import type { RecipeInfo } from "../../src/api";
import { usePackNotes } from "../../src/recipeForm/packNotes";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** A form's node pack notes speak for the machine picked in Generate on, not the first one (review S-6). */

const recipe = { id: "zz.video", family: "zz", inputs: [{ id: "cache", type: "boolean" }] } as unknown as RecipeInfo;

function Notes({ machine }: { machine?: string }) {
  usePackNotes(recipe, { cache: true }, machine);
  return null;
}

describe("a form's node pack notes", () => {
  it("are asked of the machine picked, and of the first with Auto", async () => {
    fakeApi.on("POST /form/packs", { machine: "m2", rule: "ask", notes: [] });
    const { rerender } = draw(<Notes machine="m2" />);
    await waitFor(() => expect(fakeApi.calls("POST", "/form/packs").map((c) => c.body)).toContainEqual({ recipe: "zz.video", input: { cache: true }, machine: "m2" }));
    rerender(<Notes />);
    await waitFor(() => expect(fakeApi.calls("POST", "/form/packs").map((c) => c.body)).toContainEqual({ recipe: "zz.video", input: { cache: true } }));
  });
});
