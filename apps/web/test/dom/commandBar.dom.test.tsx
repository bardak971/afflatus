import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { BarHost } from "../../src/bar/BarHost";
import { ContextMenu, useMenu } from "../../src/ContextMenu";
import { draw } from "./render";

/** A button with a right-click menu whose first item is `run`, and the command bar as the app mounts it. */
function Screen({ run }: { run(): void }) {
  const menu = useMenu<string>();
  return (
    <>
      <button type="button" onContextMenu={(e) => menu.open(e, "it")}>Opener</button>
      {menu.menu && <ContextMenu at={menu.menu.at} items={[{ label: "Menu's own", run }, { label: "Another", run }]} label="Actions on it" onClose={menu.close} />}
      <BarHost />
    </>
  );
}

describe("the command bar opened over a right-click menu", () => {
  // the bar is a chunk of its own, fetched while the app is idle: here, before the test, as the app has it by then
  beforeAll(() => import("../../src/bar/CommandBar"));

  it("closes the menu and keeps the keys: the arrows move the bar's selection, Enter runs none of the menu's items", async () => {
    const run = vi.fn();
    const { user } = draw(<Screen run={run} />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.contextMenu(opener, { button: -1, clientX: 0, clientY: 0 });
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Control>}k{/Control}");
    const box = await screen.findByRole("combobox", { name: "Search Afflatus" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(screen.queryByRole("menu")).toBeNull();

    // the commands are listed without the server (">"): the selection starts on the first and ↓ moves it
    await user.keyboard(">");
    await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBeTruthy());
    const first = box.getAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).not.toBe(first);

    await user.keyboard("{ArrowUp}");
    expect(box.getAttribute("aria-activedescendant")).toBe(first);

    // Enter is the bar's: the command chosen (Render clips…) is written in the box to add its figures; the menu's item does not run
    await user.keyboard("{Enter}");
    expect(run).not.toHaveBeenCalled();
    expect((box as HTMLInputElement).value).toMatch(/^>\s*render clips/i);
  });
});
