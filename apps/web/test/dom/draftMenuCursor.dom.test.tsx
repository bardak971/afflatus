import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { DraftBrief } from "../../src/api";
import { DraftMenu } from "../../src/screens/studio/DraftMenu";
import { draw } from "./render";

/**
 * The drafts list's arrow cursor (review S-15): it starts on the open draft's row of the list shown, which folds the
 * unused drafts, so Enter there opens nothing else.
 */

const brief = (id: string, over: Partial<DraftBrief> = {}): DraftBrief => ({ id, recipe: "zz-test.text", title: `zz-test ${id}`, name: null, updatedAt: "2026-10-15T10:00:00Z", empty: false, projectId: null, ...over });

describe("the drafts list's cursor", () => {
  it("starts on the open draft's row when unused drafts above it are folded away", async () => {
    // two unused drafts before the open one: folded, they leave it second in the list shown: the fourth (the old cursor) is another draft
    const drafts = [brief("a"), brief("u1", { unused: true, title: "" }), brief("u2", { unused: true, title: "" }), brief("open"), brief("b"), brief("c")];
    const onPick = vi.fn();
    const { user } = draw(<DraftMenu drafts={drafts} open={drafts[3]!} titleOf={(d) => d.title} onPick={onPick} onNew={() => {}} onClearUnused={async () => {}} menuOf={() => []} />);
    await user.click(screen.getByRole("button", { name: /^Drafts:/ }));
    const search = await screen.findByRole("combobox", { name: "Search drafts" });
    const active = search.getAttribute("aria-activedescendant");
    expect(active && document.getElementById(active)?.textContent).toContain("zz-test open");
    await user.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
  });
});
