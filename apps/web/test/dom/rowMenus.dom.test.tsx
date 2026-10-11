import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Project } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { ContextMenu } from "../../src/ContextMenu";
import { loadConfirmDialog } from "../../src/lazyParts";
import { rowOf } from "../../src/projects/useKindActions";
import { useRowMenus } from "../../src/projects/useRowMenus";
import { useTreeActions } from "../../src/projects/useTreeActions";
import type { Row } from "../../src/projects/tree";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const project: Project = {
  id: "zz-test-project", name: "zz-test project", folderId: null, archivedAt: null, createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z",
} as Project;

/** A timeline, a draft and a folder of the Inbox, as the panel has them picked. */
const timeline = rowOf("timeline", "zz-test-timeline", "zz-test timeline", null, { key: "t:zz-test-timeline", moving: { kind: "timeline", id: "zz-test-timeline", group: null, folder: null, name: "zz-test timeline" } });
const draft = rowOf("draft", "zz-test-draft", "zz-test draft", null, { key: "dr:zz-test-draft", moving: { kind: "draft", id: "zz-test-draft", group: null, name: "zz-test draft" } });
const folder = rowOf("folder", "zz-test-folder", "zz-test folder", null, { key: "f:zz-test-folder", moving: { kind: "folder", id: "zz-test-folder", group: null, parent: null, name: "zz-test folder" } });

/** The Projects panel's menus over these picked rows, the first one's menu opened by a right-click on its button. */
function Panel({ rows }: { rows: Row[] }) {
  const actions = useTreeActions();
  const menus = useRowMenus({
    picked: new Map(rows.map((r) => [r.key, r])), rows, byKey: new Map(rows.map((r) => [r.key, r])), scoped: false, projects: [project], folders: [], groups: [],
    binCount: 0, binBytes: 0, actions, setProject: () => {}, setOpen: () => {}, setFocused: () => {}, setClearAsk: () => {}, clearPicks: () => {},
    activate: () => {}, startRename: () => {}, duplicate: () => {}, remove: (rs) => void actions.remove(rs), importInto: () => {}, onView: () => {}, showInStudio: () => {},
  });
  const first = rows[0]!;
  return (
    <>
      <button type="button" onContextMenu={(e) => menus.openRowMenu(first, e)}>{first.label}</button>
      {menus.menu && <ContextMenu at={menus.menu.at} items={menus.menuItems(menus.menu.subject)} label="Actions on the picked rows" onClose={menus.closeMenu} />}
      <ConfirmHost />
    </>
  );
}

/** The picked rows' menu, opened on the first one. */
function openMenu(rows: Row[]) {
  fakeApi.on("PATCH /timelines/:id", { ok: true });
  fakeApi.on("PATCH /folders/:id", { ok: true });
  fakeApi.on("PUT /drafts/:id", { ok: true });
  fakeApi.on("DELETE /timelines/:id", { ok: true });
  fakeApi.on("DELETE /drafts/:id", { ok: true });
  fakeApi.on("DELETE /folders/:id", { ok: true });
  const drawn = draw(<Panel rows={rows} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: rows[0]!.label }), { button: 2, clientX: 30, clientY: 30 });
  return { ...drawn, menu: screen.getByRole("menu", { name: "Actions on the picked rows" }) };
}

/** Each write the menu sent: its method and path. */
const writes = () => ["PATCH", "PUT", "DELETE"].flatMap((m) => fakeApi.calls(m, "/").map((c) => `${c.method} ${c.path}`)).sort();

describe("the Projects panel's menu of several picked rows of different kinds, drawn", () => {
  beforeAll(() => loadConfirmDialog());

  it("moves a timeline and a draft each as what it is", async () => {
    const { user, menu } = openMenu([timeline, draft]);
    await user.click(within(menu).getByRole("menuitem", { name: /Move 2 to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "zz-test project" }));
    await waitFor(() => expect(writes()).toEqual(["PATCH /timelines/zz-test-timeline", "PUT /drafts/zz-test-draft"]));
  });

  it("moves a timeline and a folder each as what it is", async () => {
    const { user, menu } = openMenu([timeline, folder]);
    await user.click(within(menu).getByRole("menuitem", { name: /Move 2 to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "zz-test project" }));
    await waitFor(() => expect(writes()).toEqual(["PATCH /folders/zz-test-folder", "PATCH /timelines/zz-test-timeline"]));
  });

  it("deletes a timeline, a draft and a folder each as what it is", async () => {
    const { user, menu } = openMenu([timeline, draft, folder]);
    await user.click(within(menu).getByRole("menuitem", { name: /Delete 3…/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes()).toEqual(["DELETE /drafts/zz-test-draft", "DELETE /folders/zz-test-folder", "DELETE /timelines/zz-test-timeline"]));
  });
});
