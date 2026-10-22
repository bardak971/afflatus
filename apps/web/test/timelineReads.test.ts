import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys } from "../src/queryKeys";
import { EVERY_MS, readSent, timelineReader, WAIT_MS } from "../src/timelineReads";

/**
 * The timeline on screen as the editor holds it (one observer, as useTimeline), read from a pretend server that takes
 * `ms` to answer; `built` counts the views the server built, a read the page cancelled included (the server has no abort).
 */
function editor(ms = 15) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const server = { built: 0 };
  const key = queryKeys.timelines.one("zz-test");
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: ({ queryKey }) => {
      readSent(queryKey);
      server.built++;
      return new Promise((done) => setTimeout(() => done({ at: Date.now() }), ms));
    },
  });
  const stop = observer.subscribe(() => {});
  /** The edit's own read back, as useTimelineMutations' `after`. */
  const readBack = () => void client.invalidateQueries({ queryKey: queryKeys.timelines.all() });
  return { client, server, stop, readBack, reader: timelineReader(client) };
}

describe("the timelines read again after a change (perf review 2026-10-22, M-16 and L-35)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("reads an edit's timeline once: its event, heard before the answer, is stood for by the edit's own read back", async () => {
    const e = editor();
    await vi.advanceTimersByTimeAsync(100);
    const before = e.server.built;
    // the server sends "timeline" within the edit, then answers it 15 ms later
    e.reader({ tree: true });
    await vi.advanceTimersByTimeAsync(15);
    e.readBack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.server.built - before).toBe(1);
    e.stop();
  });

  it("reads once for a clip's job that ended: its \"timeline\" event and its end seen in the queue", async () => {
    const e = editor();
    await vi.advanceTimersByTimeAsync(100);
    const before = e.server.built;
    e.reader({ tree: true });
    await vi.advanceTimersByTimeAsync(40);
    e.reader();
    await vi.advanceTimersByTimeAsync(WAIT_MS - 50);
    expect(e.server.built - before).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.server.built - before).toBe(1);
    e.stop();
  });

  it("still reads a change heard after a read was sent: that read may have been built before it", async () => {
    const e = editor(100);
    await vi.advanceTimersByTimeAsync(200);
    const before = e.server.built;
    e.readBack();
    await vi.advanceTimersByTimeAsync(10);
    e.reader();
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.server.built - before).toBe(2);
    e.stop();
  });

  it("reads a run of changes at most once a second, the last one included", async () => {
    const e = editor();
    await vi.advanceTimersByTimeAsync(100);
    const before = e.server.built;
    for (let k = 0; k < 20; k++) {
      e.reader();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    const reads = e.server.built - before;
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(Math.ceil(2000 / EVERY_MS) + 1);
    e.stop();
  });
});
