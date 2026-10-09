import { describe, expect, it } from "vitest";
import { shortcutOf } from "../src/bar/store";
import { BAR_DEFAULT } from "../src/keys/table";
import { refusal } from "../src/screens/settings/reservedKeys";

const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, code = "") =>
  shortcutOf({ key, code, ctrlKey: Boolean(mods.ctrl), metaKey: Boolean(mods.meta), altKey: Boolean(mods.alt), shiftKey: Boolean(mods.shift) })!;

describe("the command bar's shortcut recorder", () => {
  it("refuses the keys the screens use, saying what uses them", () => {
    expect(refusal(press("b", { ctrl: true }))).toBe("Ctrl+B is used by Split at the playhead (Timeline editor): pick another");
    expect(refusal(press("F2"))).toMatch(/^F2 is used by Rename/);
    expect(refusal(press("F10", { shift: true }))).toMatch(/Projects panel/);
    expect(refusal(press("Enter", { ctrl: true }))).toMatch(/Generate/);
    expect(refusal(press("ArrowLeft", { alt: true }))).toMatch(/Move one place earlier/);
    expect(refusal(press("ArrowUp", { ctrl: true }))).toMatch(/Weight of the tag/);
    expect(refusal(press("a", { ctrl: true }))).toMatch(/Select all/);
    expect(refusal(press("Z", { ctrl: true, shift: true }))).toMatch(/Redo/);
  });
  it("reads the command key as Ctrl and names it ⌘", () => {
    expect(refusal(press("b", { meta: true }))).toBe("⌘+B is used by Split at the playhead (Timeline editor): pick another");
  });
  it("knows Alt+[ and Alt+] by the key's place, whatever Alt makes the keyboard type there", () => {
    expect(refusal(press("[", { alt: true }, "BracketLeft"), "BracketLeft")).toMatch(/Previous \/ next take/);
    expect(refusal(press("“", { alt: true }, "BracketLeft"), "BracketLeft")).toMatch(/Previous \/ next take/);
    expect(refusal(press("‘", { alt: true }, "BracketRight"), "BracketRight")).toMatch(/Previous \/ next take/);
  });
  it("says a browser key is the browser's", () => {
    expect(refusal(press("F5"))).toBe("F5 is the browser's Reload: pick another");
  });
  it("leaves the bar's own default free, and the text boxes' copy and paste refused", () => {
    expect(refusal(BAR_DEFAULT)).toBeNull();
    expect(refusal(press("v", { ctrl: true }))).toMatch(/Paste/);
  });
  it("lets free keys through", () => {
    expect(refusal(press("k", { ctrl: true }))).toBeNull();
    expect(refusal(press("k", { ctrl: true, shift: true }))).toBeNull();
    expect(refusal(press("F8"))).toBeNull();
    expect(refusal(press("Space", { alt: true }))).toBeNull();
  });
});
