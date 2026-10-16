import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { queryKeys } from "../../src/queryKeys";
import { useQueueOps } from "../../src/queueOps";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** The queue's Reconnect (queueOps.ts): ComfyUI asked again, and no machine's pause touched. */

function Reconnect() {
  const ops = useQueueOps();
  return <button onClick={() => ops.reconnect.mutate()}>{ops.reconnect.isSuccess ? "asked" : "Reconnect"}</button>;
}

describe("Reconnect", () => {
  it("asks ComfyUI again without resuming a machine paused by hand or by a GPU hunt", async () => {
    fakeApi.on("POST /setup/rescan", { comfy: { online: true, url: "http://zz-test:8188" }, lists: [], recipes: [] });
    const { user, client } = draw(<Reconnect />);
    // several machines, one of them going: the queue as a whole is not paused, two machines are
    client.setQueryData(queryKeys.queue(), {
      paused: false,
      machines: [{ id: "m1", paused: true }, { id: "m2", paused: true }, { id: "m3", paused: false }],
    });
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "asked" })).toBeTruthy());
    expect(fakeApi.calls("POST", "/setup/rescan")).toHaveLength(1);
    expect(fakeApi.calls("POST", "/queue/resume")).toEqual([]);
  });
});
