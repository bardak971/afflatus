import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ExportCsv } from "../../src/screens/queue/ExportCsv";
import { csvQuery } from "../../src/screens/queue/useTimesView";
import { useBanners } from "../../src/store";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/** A Queue tab's Export CSV (ExportCsv.tsx): the server's file saved under its name; a refusal said, nothing saved. */

const csvAnswer = (name: string) => new Response("﻿kind\r\nsession\r\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

/** The anchors clicked to save a file, with the name each was saved as. */
function saved(): string[] {
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  // the page's own blob addresses, which the test page may not make: a file of its own runs each test file apart
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:zz-test"), revokeObjectURL: vi.fn() });
  return names;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Export CSV", () => {
  it("asks the server for the tab's file and saves it under the name the server gives", async () => {
    const names = saved();
    fakeApi.on("GET /costs.csv", () => csvAnswer("afflatus-costs-2026-10-01_2026-10-16.csv"));
    const { user } = draw(<ExportCsv path="/costs.csv?from=1&to=2" fallbackName="afflatus-costs.csv" />);
    await user.click(screen.getByRole("button", { name: /^Export CSV$/ }));
    await waitFor(() => expect(names).toEqual(["afflatus-costs-2026-10-01_2026-10-16.csv"]));
    expect(fakeApi.calls("GET", "/costs.csv").map((c) => c.path)).toEqual(["/costs.csv?from=1&to=2"]);
  });

  it("says a refusal as a failure, and saves nothing", async () => {
    const names = saved();
    fakeApi.on("GET /renders.csv", () => jsonAnswer({ error: "zz-test refused" }, 400));
    const { user } = draw(<ExportCsv path="/renders.csv" fallbackName="afflatus-renders.csv" />);
    await user.click(screen.getByRole("button", { name: /^Export CSV$/ }));
    await waitFor(() => expect(useBanners.getState().items.map((b) => b.title)).toEqual(["Could not export the CSV"]));
    expect(useBanners.getState().items[0]!.text).toBe("zz-test refused");
    expect(names).toEqual([]);
  });

  it("is off while the window has nothing in it, and says how a spreadsheet opens the file", () => {
    draw(<ExportCsv path="/costs.csv" fallbackName="afflatus-costs.csv" disabled />);
    expect(screen.getByRole("button", { name: /^Export CSV$/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /^Export CSV: A CSV of what this tab shows/ })).toBeTruthy();
  });
});

describe("the Render times file's query", () => {
  it("the window, and only the filters set", () => {
    expect(csvQuery({ window: { from: 1000.4, to: 2000.6 }, machine: null, model: null, only: "all" })).toBe("from=1000&to=2001");
    expect(csvQuery({ window: null, machine: "m2", model: "sdxl.text-to-picture", only: "trouble" })).toBe("machine=m2&recipe=sdxl.text-to-picture&only=trouble");
  });
});
