import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { Job, QueueStatus } from "../../src/api";
import { Banners } from "../../src/Banners";
import { queryKeys } from "../../src/queryKeys";
import { useBanners, useKeepBannersAside } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The banners on the Stage (card #317): Fix ×3 said "Inpaint done" three times, one after another, over Paint and fix's
 * strip. A picture's versions are said once now, when the last of those on their way ends; and while a board or a drawing
 * layer is up (its top is its own controls), the banners come down the right side rather than over it.
 */
const version = (id: string, status: Job["status"]): Job => ({ id, status, label: "Inpaint", kind: "render", error: null, draftId: null, versionOf: "zz-test-picture" }) as unknown as Job;
const read = (client: QueryClient, q: QueueStatus) => act(async () => {
  client.setQueryData(queryKeys.queue(), q);
  await new Promise((go) => setTimeout(go, 10));
});
const queue = (recent: Job[], waiting: Job[]): QueueStatus => ({ running: null, waiting, recent, machines: [] }) as unknown as QueueStatus;
const quiet = () => {
  fakeApi.on("GET /settings", { machines: [] });
  fakeApi.on("GET /downloads", { on: true, items: [], manager: { found: false }, via: "afflatus" });
};

function Layer() {
  useKeepBannersAside();
  return null;
}

describe("a picture's versions' banners", () => {
  it("say nothing while versions are on their way, then one banner for all of them", async () => {
    quiet();
    const { client } = draw(<Banners />, { at: "/" });
    await read(client, queue([], [version("a", "queued"), version("b", "queued"), version("c", "queued")]));
    await read(client, queue([version("a", "done")], [version("b", "queued"), version("c", "queued")]));
    await read(client, queue([version("b", "done"), version("a", "done")], [version("c", "queued")]));
    expect(useBanners.getState().items).toEqual([]);
    await read(client, queue([version("c", "done"), version("b", "done"), version("a", "done")], []));
    await waitFor(() => expect(useBanners.getState().items).toHaveLength(1));
    expect(useBanners.getState().items[0]).toMatchObject({ id: "versions:zz-test-picture", tone: "good", title: "Inpaint done · 3 versions", action: { label: "Open" } });
  });
});

describe("where the banners are drawn", () => {
  it("top centre, and down the right side while a board or a drawing layer is up", async () => {
    quiet();
    const { rerender } = draw(<Banners />);
    act(() => useBanners.getState().push({ id: "zz-test", tone: "good", title: "zz-test done" }));
    const box = () => screen.getByText("zz-test done").closest<HTMLElement>(".fixed")!;
    expect(box().className).toContain("left-1/2");
    rerender(<><Banners /><Layer /></>);
    await waitFor(() => expect(box().className).toContain("right-3"));
    expect(box().className).not.toContain("left-1/2");
    rerender(<Banners />);
    await waitFor(() => expect(box().className).toContain("left-1/2"));
  });
});
