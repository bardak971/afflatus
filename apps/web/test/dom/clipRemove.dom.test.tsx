import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { api } from "../../src/api";
import { autosaver } from "../../src/autosave";
import { clipGone } from "../../src/timeline/useClipEdits";
import { useTimelineMutations } from "../../src/timeline/useTimelineMutations";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** The timeline editor's mutations over the clips' real autosave, as useClipEdits makes it. */
function rig() {
  const saves = autosaver<Record<string, unknown>>(() => ({
    save: async (clipId, inputs) => {
      await api.editClip(clipId, { inputs });
    },
    keepalive: () => {},
    gone: clipGone,
  }));
  let m!: ReturnType<typeof useTimelineMutations>;
  function Editor() {
    m = useTimelineMutations("zz-test-timeline", {
      timeline: undefined, clipsNow: { current: [] }, recipes: [], firstRecipe: () => undefined,
      edits: { save: (only?: string) => saves.flush(only), turn: saves.turn, ready: () => ({}), inputsOf: () => ({}), editInputs: () => {}, dropEdits: () => {}, savedElsewhere: () => {}, sourceTyped: () => undefined },
      on: { note: () => {}, select: () => {}, unpick: () => {}, writing: () => {}, open: () => {} },
    });
    return null;
  }
  draw(<Editor />);
  return { saves, m: () => m };
}

/** The clips' saves and removals answered, in the order they came. */
function answerClips(): string[] {
  const came: string[] = [];
  fakeApi.on("PATCH /clips/:id", ({ path }) => (came.push(`PATCH ${path}`), { ok: true }));
  fakeApi.on("DELETE /clips/:id", ({ path }) => (came.push(`DELETE ${path}`), { ok: true }));
  return came;
}

describe("a clip removed within half a second of typing in its form, drawn", () => {
  it("saves what was typed first, then removes it; nothing is left said failed", async () => {
    const came = answerClips();
    const { saves, m } = rig();
    saves.queue("zz-test-clip", { prompt: "typed just now" });
    m().remove.mutate("zz-test-clip");
    await waitFor(() => expect(m().remove.isSuccess).toBe(true));
    expect(came).toEqual(["PATCH /clips/zz-test-clip", "DELETE /clips/zz-test-clip"]);
    expect(saves.pending.size).toBe(0);
    expect(saves.mustAsk()).toBe(false);
  });

  it("does the same for several picked clips, removed in one call (one step for Undo, card #75)", async () => {
    const came = answerClips();
    fakeApi.on("POST /timelines/:id/clips/remove", ({ path, body }) => (came.push(`POST ${path} ${JSON.stringify(body)}`), { ok: true }));
    const { saves, m } = rig();
    saves.queue("zz-test-a", { prompt: "a" });
    saves.queue("zz-test-b", { prompt: "b" });
    m().removeMany.mutate(["zz-test-a", "zz-test-b"]);
    await waitFor(() => expect(m().removeMany.isSuccess).toBe(true));
    expect(came).toEqual(["PATCH /clips/zz-test-a", "PATCH /clips/zz-test-b", 'POST /timelines/zz-test-timeline/clips/remove {"ids":["zz-test-a","zz-test-b"]}']);
    expect(saves.pending.size).toBe(0);
  });
});
