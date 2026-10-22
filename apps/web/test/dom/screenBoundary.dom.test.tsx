import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ErrorBoundary, screenKey } from "../../src/ErrorBoundary";
import { draw } from "./render";

/** A timeline's editor that fails to draw for one timeline only. */
function Editor({ id }: { id: string }) {
  if (id === "zz-test-a") throw new Error("zz-test: the editor failed");
  return <p>editor of {id}</p>;
}

/** The screens' boundary as App draws it, around the editor of the timeline at `path`. */
const app = (path: string) => (
  <ErrorBoundary key={screenKey(path)}>
    <Editor id={path.split("/")[2]!} />
  </ErrorBoundary>
);

describe("the screens' error boundary (W-16)", () => {
  it("draws another timeline's editor afresh, opened straight from one that failed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = draw(app("/timelines/zz-test-a"));
    expect(screen.getByRole("alert").textContent).toContain("This screen failed");
    // Back, Forward, or a banner's "Open the timeline": the same route, another timeline
    rerender(app("/timelines/zz-test-b"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("editor of zz-test-b")).toBeTruthy();
  });

  it("keeps the Studio's own addresses one screen, and each workflow editor its own", () => {
    expect(screenKey("/create")).toBe(screenKey("/timelines"));
    expect(screenKey("/")).toBe(screenKey("/timelines"));
    expect(screenKey("/workflows/zz-test-1/edit")).not.toBe(screenKey("/workflows/zz-test-2/edit"));
    expect(screenKey("/queue")).toBe("queue");
  });
});
