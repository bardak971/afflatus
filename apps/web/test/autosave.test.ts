import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import { autosaver, type AutosaveOpts, type SaveState } from "../src/autosave";
import { clipGone } from "../src/timeline/useClipEdits";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** An autosaver whose saves wait until each is let go, in the order they were sent, with what was said kept. */
function rig(over: Partial<AutosaveOpts<string>> = {}) {
  const sent: Array<{ key: string; item: string; done: () => void; fail: (why: string) => void; throws: (err: Error) => void }> = [];
  const kept: Array<[string, string]> = [];
  const states: Array<[SaveState, string | null]> = [];
  const opts: AutosaveOpts<string> = {
    save: (key, item) => new Promise<void>((done, no) => sent.push({ key, item, done, fail: (why) => no(new Error(why)), throws: no })),
    keepalive: (key, item) => kept.push([key, item]),
    ...over,
  };
  const s = autosaver(() => opts, (state, failure) => states.push([state, failure]));
  return { s, sent, kept, states, last: () => states[states.length - 1] };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("an autosave of clip forms (keyed)", () => {
  it("saves each clip half a second after its last change", async () => {
    const { s, sent } = rig();
    s.queue("c1", "a");
    await vi.advanceTimersByTimeAsync(300);
    s.queue("c1", "ab");
    s.queue("c2", "x");
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((x) => [x.key, x.item])).toEqual([["c1", "ab"]]);
  });

  it("takes saves in turn: a second save of a clip waits for the first to be answered", async () => {
    const { s, sent, last } = rig();
    s.queue("c1", "a");
    void s.flush("c1");
    await settle();
    s.queue("c1", "ab");
    void s.flush("c1");
    await settle();
    // the first is still out: the second is not sent beside it, where its answer could come first
    expect(sent.map((x) => x.item)).toEqual(["a"]);
    sent[0]!.done();
    await settle();
    expect(sent.map((x) => x.item)).toEqual(["a", "ab"]);
    sent[1]!.done();
    await settle();
    expect(last()).toEqual(["saved", null]);
    expect(s.pending.size).toBe(0);
  });

  it("sends every waiting clip as the tab closes, by a request that outlives the page", async () => {
    const { s, sent, kept } = rig();
    s.queue("c1", "typed just before the reload");
    s.queue("c2", "and this");
    s.hide();
    expect(kept).toEqual([["c1", "typed just before the reload"], ["c2", "and this"]]);
    // the delayed save does not go as well
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([]);
  });

  it("keeps a failed save, says why, asks before the tab closes, and sends it again on Retry", async () => {
    const { s, sent, last } = rig();
    expect(s.mustAsk()).toBe(false);
    s.queue("c1", "a");
    void s.flush();
    await settle();
    sent[0]!.fail("Afflatus is not answering");
    await settle();
    expect(last()).toEqual(["failed", "Afflatus is not answering"]);
    expect(s.pending.get("c1")).toBe("a");
    expect(s.mustAsk()).toBe(true);
    // another clip saved meanwhile does not hide that the first one is not
    s.queue("c2", "x");
    expect(last()![0]).toBe("failed");
    void s.flush("c2");
    await settle();
    sent[1]!.done();
    await settle();
    expect(last()).toEqual(["failed", "Afflatus is not answering"]);
    void s.retry();
    await settle();
    sent[2]!.done();
    await settle();
    expect(last()).toEqual(["saved", null]);
    expect(s.mustAsk()).toBe(false);
  });

  it("asks before the tab closes when a change cannot go whole as the page closes, and starts its save", async () => {
    const { s, sent } = rig({ goesWhole: (_, item) => item.length < 5 });
    s.queue("c1", "short");
    expect(s.mustAsk()).toBe(true);
    await settle();
    expect(sent.map((x) => x.item)).toEqual(["short"]);
  });

  it("keeps a change typed while its save was out", async () => {
    const { s, sent } = rig();
    s.queue("c1", "a");
    void s.flush("c1");
    await settle();
    s.queue("c1", "ab");
    sent[0]!.done();
    await settle();
    expect(s.pending.get("c1")).toBe("ab");
  });

  it("drops a clip's change when its save answers 404 (the clip removed meanwhile), and the others are said saved again", async () => {
    const { s, sent, last } = rig({ gone: clipGone });
    s.queue("c1", "typed just before the clip was removed");
    s.queue("c2", "x");
    void s.flush();
    await settle();
    sent[0]!.throws(new ApiError("No such clip", 404));
    await settle();
    sent[1]!.done();
    await settle();
    expect(s.pending.size).toBe(0);
    expect(last()).toEqual(["saved", null]);
    // a later save of another clip is said saved, and the tab closes without asking
    s.queue("c2", "xy");
    void s.flush("c2");
    await settle();
    sent[2]!.done();
    await settle();
    expect(last()).toEqual(["saved", null]);
    expect(s.mustAsk()).toBe(false);
  });

  it("keeps a clip's change failed when its save fails another way than 404", async () => {
    const { s, sent, last } = rig({ gone: clipGone });
    s.queue("c1", "a");
    void s.flush();
    await settle();
    sent[0]!.throws(new ApiError("Afflatus is not answering", 502));
    await settle();
    expect(s.pending.get("c1")).toBe("a");
    expect(last()).toEqual(["failed", "Afflatus is not answering"]);
    expect(s.mustAsk()).toBe(true);
  });

  it("lets go of a dropped change, its failure with it, and says the rest as it stands", async () => {
    const { s, sent, last } = rig();
    s.queue("c1", "a");
    s.queue("c2", "x");
    void s.flush();
    await settle();
    sent[0]!.fail("refused");
    await settle();
    expect(last()).toEqual(["failed", "refused"]);
    // the thing is gone (a draft deleted): no longer said failed, nor asked about as the tab closes; c2 still waits
    s.drop("c1");
    expect(s.pending.has("c1")).toBe(false);
    expect(s.mustAsk()).toBe(false);
    expect(last()?.[0]).toBe("saving");
    sent[1]!.done();
    await settle();
    expect(last()).toEqual(["saved", null]);
    // nothing sent again for it
    await s.retry();
    expect(sent.map((x) => x.key)).toEqual(["c1", "c2"]);
  });
});
