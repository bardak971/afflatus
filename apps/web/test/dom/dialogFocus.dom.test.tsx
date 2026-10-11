import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ProjectsTree, TimelineBrief } from "../../src/api";
import { ConfirmHost } from "../../src/Confirm";
import { loadConfirmDialog } from "../../src/lazyParts";
import { TimelineCards } from "../../src/screens/studio/TimelineCards";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const timeline: TimelineBrief = {
  id: "zz-test-timeline", name: "zz-test timeline", projectId: null, folderId: null, width: 832, height: 480,
  updatedAt: "2026-10-11T00:00:00.000Z", clips: 3, durationMs: 9000, cover: null, toRender: 0,
};
const tree: ProjectsTree = {
  totalBytes: 0,
  groups: [{
    id: null, kind: "inbox", name: "Inbox", archived: false, rootFolderId: null, counts: { drafts: 0, timelines: 1, items: 0 }, bytes: 0, folders: [],
    timelines: [{ id: timeline.id, name: timeline.name, folderId: null, clips: 3, durationMs: 9000, bytes: 0, exported: false, unusedTakes: 0, unusedBytes: 0, createdAt: timeline.updatedAt, updatedAt: timeline.updatedAt }],
  }],
};

describe("a dialog opened from a right-click menu, drawn", () => {
  // the question's dialog is a chunk the app fetches while it is idle: fetched before the test, as the app has it by then
  beforeAll(() => loadConfirmDialog());

  it("gives the focus back to what the menu was opened on, not to the page, once it closes", async () => {
    fakeApi.on("GET /projects/tree", tree);
    const { user } = draw(<><TimelineCards timelines={[timeline]} ready place={{ type: "all" }} /><ConfirmHost /></>);
    const card = screen.getByRole("link", { name: /zz-test timeline/ });
    card.focus();
    fireEvent.contextMenu(card, { button: 2, clientX: 30, clientY: 30 });
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    await screen.findByRole("dialog", { name: /Rename zz-test timeline/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card));
  });
});
