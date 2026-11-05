import { describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { Job, QueueStatus } from "../../src/api";
import { Banners } from "../../src/Banners";
import { queryKeys } from "../../src/queryKeys";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A grid's cells as they end (card #317): each said "… done" in a banner of its own over the board's column labels, a failed
 * one staying up. A grid is said once now, when its last cell ends, its failures counted in it.
 */
const cell = (id: string, status: Job["status"], at: string): Job => ({ id, status, label: `Lighthouse · ${at}`, kind: "render", error: status === "failed" ? "out of memory" : null, draftId: "d1", grid: { id: "g1", cell: at } }) as unknown as Job;
/** A read of the queue, as the page gets one, its effects run before the next (react-query tells its watchers a tick later). */
const read = (client: QueryClient, q: QueueStatus) => act(async () => {
  client.setQueryData(queryKeys.queue(), q);
  await new Promise((go) => setTimeout(go, 10));
});
const queue = (recent: Job[], waiting: Job[]): QueueStatus => ({ running: null, waiting, recent, machines: [] }) as unknown as QueueStatus;

describe("a grid's banners", () => {
  it("say nothing while cells wait, then one banner for the grid with its failures", async () => {
    fakeApi.on("GET /settings", { machines: [] });
    fakeApi.on("GET /downloads", { on: true, items: [], manager: { found: false }, via: "afflatus" });
    const { client } = draw(<Banners />, { at: "/timelines" });
    // the queue as the page holds it, set by hand: each change is a read of it
    await read(client, queue([], [cell("a", "queued", "0.0.0"), cell("b", "queued", "1.0.0"), cell("c", "queued", "2.0.0")]));
    await read(client, queue([cell("a", "done", "0.0.0")], [cell("b", "queued", "1.0.0"), cell("c", "queued", "2.0.0")]));
    await read(client, queue([cell("b", "failed", "1.0.0"), cell("a", "done", "0.0.0")], [cell("c", "queued", "2.0.0")]));
    expect(useBanners.getState().items).toEqual([]);
    await read(client, queue([cell("c", "done", "2.0.0"), cell("b", "failed", "1.0.0"), cell("a", "done", "0.0.0")], []));
    await waitFor(() => expect(useBanners.getState().items).toHaveLength(1));
    expect(useBanners.getState().items[0]).toMatchObject({ id: "grid:g1", tone: "bad", title: "Grid done · 1 of 3 renders failed" });
  });
});
