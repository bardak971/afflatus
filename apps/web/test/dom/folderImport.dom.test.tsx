import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTreeActions } from "../../src/projects/useTreeActions";
import { IMPORT_UNDER_WAY, useFolderImport } from "../../src/folderImport";
import { useBanners } from "../../src/store";
import type { Target } from "../../src/projects/tree";
import { fakeApi, later } from "./fakeApi";

/**
 * A folder of the computer imported from the Projects panel (useTreeActions' importFolder): into the Inbox it lands in
 * the folder made there for it, never in another project's top folder of the same name; a second import while one runs
 * is refused out loud, before anything is made or said imported.
 */

/** A file as the browser gives it from a picked folder: its path under that folder in `webkitRelativePath`. */
function picked(path: string, type = "image/png"): File {
  const file = new File(["x"], path.split("/").at(-1)!, { type });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

const inbox: Target = { kind: "group", group: null, root: null, name: "Inbox" };

function tree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...renderHook(() => useTreeActions(), { wrapper }), client };
}

/** The folder each upload asked for, from its query. */
const uploadedInto = () => fakeApi.calls("POST", "/assets").map((a) => new URL(a.path, "http://x").searchParams.get("folder"));

describe("a folder imported into the Inbox", () => {
  it("lands in the folder made for it, not in another project's folder of the same name", async () => {
    // project Harbor already has a top folder "shoots", and a linked one of the disk too
    fakeApi.on("GET /folders", { items: [
      { id: "harbor-shoots", parentId: null, name: "shoots", count: 3, projectId: "harbor", path: null, root: false },
      { id: "disk-shoots", parentId: null, name: "shoots", count: 9, projectId: "other", path: "D:/shoots", root: true },
    ] });
    let n = 0;
    fakeApi.on("POST /folders", ({ body }) => ({ id: `made-${++n}`, parentId: (body as { parentId: string | null }).parentId, name: (body as { name: string }).name, count: 0, projectId: null, path: null, root: false }));
    fakeApi.on("POST /assets", { id: "a1" });
    const { result, client } = tree();
    await act(() => result.current.importFolder([picked("shoots/one.png"), picked("shoots/day2/two.png")], inbox, client));
    await waitFor(() => expect(useFolderImport.getState().run?.over).toBe(true));

    // "shoots" made once in the Inbox, "day2" under it; the files in those, none in Harbor's or the disk's
    const made = fakeApi.calls("POST", "/folders").map((a) => a.body);
    expect(made).toEqual([{ name: "shoots", parentId: null, project: null }, { name: "day2", parentId: "made-1" }]);
    expect(uploadedInto().sort()).toEqual(["made-1", "made-2"]);
  });
});

describe("a second folder import while one runs", () => {
  it("is refused out loud, with nothing made", async () => {
    fakeApi.on("GET /folders", { items: [] });
    let n = 0;
    fakeApi.on("POST /folders", ({ body }) => ({ id: `made-${++n}`, parentId: null, name: (body as { name: string }).name, count: 0, projectId: null, path: null, root: false }));
    const upload = later<object>();
    fakeApi.on("POST /assets", () => upload.promise);
    const { result, client } = tree();
    void act(() => result.current.importFolder([picked("shoots/one.png")], inbox, client));
    await waitFor(() => expect(fakeApi.calls("POST", "/assets")).toHaveLength(1));

    await act(() => result.current.importFolder([picked("holiday/two.png")], inbox, client));
    expect(useBanners.getState().items.map((b) => b.title)).toContain(IMPORT_UNDER_WAY);
    // the second folder was not made in the Inbox
    expect(fakeApi.calls("POST", "/folders").map((a) => (a.body as { name: string }).name)).toEqual(["shoots"]);
    upload.answer({ id: "a1" });
    await waitFor(() => expect(useFolderImport.getState().run?.over).toBe(true));
  });
});
