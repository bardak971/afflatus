import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ContextMenu, useMenu, type MenuItem } from "../../src/ContextMenu";
import { draw } from "./render";

/** A button with a right-click menu: two actions, an item that is off, a setting ticked on and off. */
function Opener({ alpha, omega }: { alpha(): void; omega(): void }) {
  const menu = useMenu<string>();
  const [loop, setLoop] = useState(false);
  const items: MenuItem[] = [
    { label: "Alpha", run: alpha },
    "—",
    { label: "Off", disabled: true, note: "ComfyUI is offline", run: () => {} },
    { label: "Loop", checked: loop, run: () => setLoop((on) => !on) },
    { label: "Omega", run: omega },
  ];
  return (
    <>
      <button type="button" onContextMenu={(e) => menu.open(e, "it")}>Opener</button>
      <button type="button">Elsewhere</button>
      <span data-testid="loop">{loop ? "on" : "off"}</span>
      {menu.menu && <ContextMenu at={menu.menu.at} items={items} label="Actions on it" head={{ title: "It" }} onClose={menu.close} />}
    </>
  );
}

/** Opened from the keyboard (the menu key: no button, the pointer at 0, 0), on the opener with the focus. */
function openByKey() {
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  fireEvent.contextMenu(opener, { button: -1, clientX: 0, clientY: 0 });
  return opener;
}

const active = () => {
  const menu = screen.getByRole("menu");
  const id = menu.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

describe("a right-click menu, drawn", () => {
  it("takes the focus on its panel, its first item active and announced", () => {
    draw(<Opener alpha={() => {}} omega={() => {}} />);
    openByKey();
    const menu = screen.getByRole("menu", { name: "Actions on it" });
    expect(document.activeElement).toBe(menu);
    expect(active()).toBe("Alpha");
    expect(screen.getByRole("menuitemcheckbox", { name: "Loop" }).getAttribute("aria-checked")).toBe("false");
  });

  it("opened with the mouse, has nothing active until an arrow is pressed", async () => {
    const { user } = draw(<Opener alpha={() => {}} omega={() => {}} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Opener" }), { button: 2, clientX: 40, clientY: 40 });
    expect(active()).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("Alpha");
  });

  it("walks the items that can run with the arrows, Home and End, past the rule and the item that is off", async () => {
    const { user } = draw(<Opener alpha={() => {}} omega={() => {}} />);
    openByKey();
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("Loop");
    await user.keyboard("{End}");
    expect(active()).toBe("Omega");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("Alpha");
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe("Omega");
    await user.keyboard("{Home}");
    expect(active()).toBe("Alpha");
  });

  it("runs the active item on Enter, closes, and gives the focus back to its opener", async () => {
    const alpha = vi.fn();
    const omega = vi.fn();
    const { user } = draw(<Opener alpha={alpha} omega={omega} />);
    const opener = openByKey();
    await user.keyboard("{End}{Enter}");
    expect(omega).toHaveBeenCalledOnce();
    expect(alpha).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("runs the active item on Space too, and Space ticks a setting on and off", async () => {
    const alpha = vi.fn();
    const { user } = draw(<Opener alpha={alpha} omega={() => {}} />);
    openByKey();
    await user.keyboard(" ");
    expect(alpha).toHaveBeenCalledOnce();
    openByKey();
    await user.keyboard("{ArrowDown} ");
    expect(screen.getByTestId("loop").textContent).toBe("on");
    openByKey();
    expect(screen.getByRole("menuitemcheckbox", { name: "Loop" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{ArrowDown} ");
    expect(screen.getByTestId("loop").textContent).toBe("off");
  });

  it("closes on Escape, running nothing, the focus back on its opener", async () => {
    const alpha = vi.fn();
    const { user } = draw(<Opener alpha={alpha} omega={() => {}} />);
    const opener = openByKey();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(alpha).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("closes when the focus goes elsewhere (a dialog or the command bar opened over it), and leaves the focus there", () => {
    draw(<Opener alpha={() => {}} omega={() => {}} />);
    openByKey();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("closes on a click outside it", async () => {
    const { user } = draw(<Opener alpha={() => {}} omega={() => {}} />);
    openByKey();
    await user.click(screen.getByTestId("loop"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
