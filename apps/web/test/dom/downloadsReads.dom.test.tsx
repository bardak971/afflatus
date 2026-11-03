import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../src/api";
import { useLiveEvents } from "../../src/live";
import { queryKeys } from "../../src/queryKeys";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The downloads list while a file comes in (card #241): the server tells its bytes twice a second, and every open tab read
 * the whole list again each time (26 KB with a day's downloads kept, ~120 reads a minute). It is read at most every 2 s now,
 * the last event read too, so the list still ends as the server has it.
 */

/** The server's event stream, as the test sends its events. */
class FakeSource {
  static last: FakeSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  private heard = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor() {
    FakeSource.last = this;
  }
  addEventListener(name: string, on: (e: MessageEvent<string>) => void) {
    this.heard.set(name, [...(this.heard.get(name) ?? []), on]);
  }
  close() {
    this.readyState = 2;
  }
  send(name: string) {
    for (const on of this.heard.get(name) ?? []) on(new MessageEvent(name, { data: "" }));
  }
}
beforeEach(() => vi.stubGlobal("EventSource", FakeSource));
afterEach(() => vi.unstubAllGlobals());

const wait = (ms: number) => act(() => new Promise((done) => setTimeout(done, ms)));

function Downloads() {
  useLiveEvents();
  const list = useQuery({ queryKey: queryKeys.downloads(), queryFn: ({ signal }) => api.downloads({ signal }) });
  return <p>{list.data ? `${list.data.items.length} downloads` : "…"}</p>;
}

describe("the downloads list on the server's events", () => {
  it("is read at most every 2 s while a download tells its bytes, and once after the last event", async () => {
    let items = 0;
    fakeApi.on("GET /downloads", () => ({ on: true, items: Array.from({ length: items }, (_, i) => ({ id: `zz-${i}` })), manager: { found: true }, via: "manager" }));
    draw(<Downloads />);
    await screen.findByText("0 downloads");
    const reads = () => fakeApi.calls("GET", "/downloads").length;
    expect(reads()).toBe(1);
    // 3 s of a download's events, twice a second
    for (let i = 0; i < 6; i++) {
      items = i + 1;
      FakeSource.last!.send("downloads");
      await wait(500);
    }
    await wait(2100);
    // the first event read at once, then one read per 2 s and the last: four reads where there were seven
    expect(reads()).toBeLessThanOrEqual(4);
    expect(screen.getByText("6 downloads")).toBeTruthy();
  });
});
