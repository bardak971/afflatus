import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useLocation } from "wouter";
import { Screens } from "../../src/App";
import { screenKey } from "../../src/ErrorBoundary";
import { draw } from "./render";

// the timeline editor's chunk stood in for: an editor that fails to draw for one timeline only
vi.mock("../../src/screens/TimelineEditor", () => ({
  TimelineEditor: ({ params }: { params: { id: string } }) => {
    if (params.id === "zz-test-a") throw new Error("zz-test: the editor failed");
    return <p>editor of {params.id}</p>;
  },
}));

/** App's own screens, routes and keyed boundary, on the address the router is at, as App hands it to them. */
function Host() {
  const [path] = useLocation();
  return (
    <Suspense fallback={null}>
      <Screens path={path} firstLaunch={false} />
    </Suspense>
  );
}

describe("the screens' error boundary (W-16)", () => {
  it("draws another timeline's editor afresh, opened straight from one that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { location } = draw(<Host />, { at: "/timelines/zz-test-a" });
    expect((await screen.findByRole("alert")).textContent).toContain("This screen failed");
    // Back, Forward, or a banner's "Open the timeline": the same route, another timeline
    act(() => location.navigate("/timelines/zz-test-b"));
    expect(await screen.findByText("editor of zz-test-b")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the Studio's own addresses one screen, and each workflow editor its own", () => {
    expect(screenKey("/create")).toBe(screenKey("/timelines"));
    expect(screenKey("/")).toBe(screenKey("/timelines"));
    expect(screenKey("/workflows/zz-test-1/edit")).not.toBe(screenKey("/workflows/zz-test-2/edit"));
    expect(screenKey("/queue")).toBe("queue");
  });
});
