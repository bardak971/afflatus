import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ProjectsTree, TimelineBrief } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { loadConfirmDialog } from "../../src/lazyParts";
import { deleteQuestion } from "../../src/projects/kindActions";
import { TimelineCards } from "../../src/screens/studio/TimelineCards";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const timeline: TimelineBrief = {
  id: "zz-test-timeline", name: "zz-test timeline", projectId: null, folderId: null, width: 832, height: 480,
  updatedAt: "2026-10-11T00:00:00.000Z", clips: 3, durationMs: 9000, cover: null, toRender: 0,
};

/** The Projects panel's tree, as the cards read their unused takes and export from it: none unused, never exported. */
const tree: ProjectsTree = {
  totalBytes: 0,
  groups: [{
    id: null, kind: "inbox", name: "Inbox", archived: false, rootFolderId: null, counts: { drafts: 0, timelines: 1, items: 0 }, bytes: 0, folders: [],
    timelines: [{ id: timeline.id, name: timeline.name, folderId: null, clips: 3, durationMs: 9000, bytes: 0, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt: timeline.updatedAt, updatedAt: timeline.updatedAt }],
  }],
};

/** The Studio's timeline cards, with the host of the questions the app asks. */
async function cardMenu() {
  fakeApi.on("GET /projects/tree", tree);
  const drawn = draw(<><TimelineCards timelines={[timeline]} ready place={{ type: "all" }} /><ConfirmHost /></>);
  const card = screen.getByRole("link", { name: /zz-test timeline/ });
  // its unused takes are read with the tree: until then Bin unused takes says "reading…"
  await waitFor(() => expect(fakeApi.calls("GET", "/projects/tree")).toHaveLength(1));
  await waitFor(() => {
    fireEvent.contextMenu(card, { button: 2, clientX: 30, clientY: 30 });
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Bin unused takes/ }).textContent).not.toContain("reading…");
  });
  return { ...drawn, menu: screen.getByRole("menu", { name: "Actions on this timeline" }) };
}

/** Each line of the menu: its words (label, note, key) and whether it is off. */
const lines = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((b) => `${b.textContent}${(b as HTMLButtonElement).disabled ? " (off)" : ""}`);

describe("a timeline card's menu (the kind's one list), drawn", () => {
  // the question's dialog is a chunk the app fetches while it is idle: fetched before the test, as the app has it by then
  beforeAll(() => loadConfirmDialog());

  it("lists the timeline's actions in order, an action that cannot run off with its reason as its note", async () => {
    const { menu } = await cardMenu();
    expect(lines(menu)).toEqual([
      "OpenEnter",
      "Show in Projects",
      "Render missing clipsnone to render (off)",
      "Finish…",
      "Export…",
      "Fix allwhat Needs attention lists",
      "RenameF2",
      "Put in a folderno folder in its project (off)",
      "Move tono project yet (off)",
      "Bin unused takes…none (off)",
      "Delete…videos stayDel",
    ]);
  });

  it("asks the kind's one Delete question, and deletes only once it is answered yes", async () => {
    fakeApi.on("DELETE /timelines/:id", { ok: true });
    const { user } = await cardMenu();
    await user.click(screen.getByRole("menuitem", { name: /Delete…/ }));
    expect(screen.queryByRole("menu")).toBeNull();

    const question = deleteQuestion("timeline", [timeline.name]);
    const dialog = await screen.findByRole("dialog", { name: question.title });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog.textContent).toContain(question.text);
    expect(fakeApi.calls("DELETE", "/timelines/")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: question.yes }));
    await waitFor(() => expect(fakeApi.calls("DELETE", "/timelines/")).toEqual([expect.objectContaining({ path: `/timelines/${timeline.id}` })]));
  });

  it("deletes nothing when the question is answered Keep", async () => {
    const { user } = await cardMenu();
    await user.click(screen.getByRole("menuitem", { name: /Delete…/ }));
    const dialog = await screen.findByRole("dialog", { name: `Delete ${timeline.name}?` });
    await user.click(within(dialog).getByRole("button", { name: /Keep/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fakeApi.calls("DELETE", "/timelines/")).toHaveLength(0);
  });
});
