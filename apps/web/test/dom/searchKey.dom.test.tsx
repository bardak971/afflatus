import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchKey } from "../../src/Keys";

/**
 * "/" (useSearchKey) with a modal dialog open: it never moves the focus to a search box behind the dialog; a search box
 * of the dialog itself is still reached.
 */

function Page({ ownSearch }: { ownSearch?: boolean }) {
  useSearchKey();
  return (
    <>
      <input aria-label="Search the library" data-search="" />
      <div role="dialog" aria-modal="true">
        <button type="button">Keep</button>
        {ownSearch && <input aria-label="Search the dialog" data-search="" />}
      </div>
    </>
  );
}

beforeEach(() => {
  // jsdom lays nothing out: every element is taken as drawn on screen, as in a browser
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => vi.restoreAllMocks());

describe('"/" with a modal open', () => {
  it("leaves the focus in the dialog, not on the search box behind it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    screen.getByRole("button", { name: "Keep" }).focus();
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
  });
  it("reaches the dialog's own search box", async () => {
    const user = userEvent.setup();
    render(<Page ownSearch />);
    screen.getByRole("button", { name: "Keep" }).focus();
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Search the dialog"));
  });
});
