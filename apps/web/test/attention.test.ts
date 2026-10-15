import { describe, expect, it } from "vitest";
import type { Asset, Clip, Take } from "../src/api";
import { attention, attentionLine, canDismiss, clipWords, dismissKey, fixAll, fixWords, planFix, plansToAsk, withPlans, type JoinFigures, type Row } from "../src/timeline/attention";

/** A clip with only what the rows read. */
const clip = (over: Partial<Clip> & { id: string }): Clip =>
  ({ kind: "video", recipe: "h3.video", inputs: {}, takes: [], joined: "continue", join: "fresh", fill: false, take: null, job: null, failed: null, ...over }) as unknown as Clip;
const take = (id: string, handover?: number): Take => ({ id, startMs: 0, endMs: 3000, asset: { id: `v-${id}` } as Asset, measure: handover === undefined ? null : { handover } }) as unknown as Take;
const rendered = (id: string, takes: string[], over: Partial<Clip> = {}) => clip({ id, takes: takes.map((t) => take(t)), take: take(takes[0]!), ...over });

const ms = (c: Clip) => (c.id === "slow" ? null : 60_000);
const read = (clips: Clip[], joins: Record<string, JoinFigures | undefined> = {}, misfit: string[] = []) =>
  attention(clips, { joins: new Map(Object.entries(joins)), renderable: (c) => c.kind === "video" && !c.job, msOf: ms, misfit: (c) => misfit.includes(c.id) && !c.fill });

describe("the rows of Needs attention", () => {
  it("lists clips with no take yet, rendered together with their estimate", () => {
    const rows = read([rendered("a", ["t"]), clip({ id: "b" }), clip({ id: "slow" }), clip({ id: "q", job: { id: "j", status: "queued" } })]);
    expect(rows).toEqual([{ key: "missing", kind: "missing", ids: ["b", "slow"], warn: false, act: { do: "render", clips: ["b", "slow"], ms: 60_000 } }]);
  });
  it("lists a clip whose form is still to fill, with nothing to render", () => {
    const rows = attention([clip({ id: "a" })], { joins: new Map(), renderable: () => false, msOf: ms, misfit: () => false });
    expect(rows.map((r) => [r.kind, r.ids, r.act])).toEqual([["missing", ["a"], undefined]]);
  });
  it("lists a failed clip once, as failed, with its reason and a retry", () => {
    const rows = read([clip({ id: "a", failed: "out of memory" })]);
    expect(rows.map((r) => [r.kind, r.ids, r.reasons, r.act])).toEqual([["failed", ["a"], [{ clip: "a", why: "out of memory" }], { do: "render", clips: ["a"], ms: 60_000 }]]);
  });
  it("re-renders a clip whose clip before changed, without a join row of its own", () => {
    const rows = read([rendered("a", ["t"]), rendered("b", ["u"], { join: "stale" })], { b: [{ take: "u", in: 9, out: null }] });
    expect(rows.map((r) => [r.kind, r.ids, r.act?.do])).toEqual([["stale", ["b"], "render"]]);
  });
  it("offers the smoothest other take that comes in under ×3, its run-up end too", () => {
    const b = clip({ id: "b", takes: [take("u"), take("v", 4), take("w"), take("x")], take: take("u") });
    const rows = read([rendered("a", ["t"]), b], { b: [{ take: "u", in: 4.8, out: null }, { take: "v", in: 1.1, out: null }, { take: "w", in: 2.4, out: null }, { take: "x", in: 1.2, out: null }] });
    expect(rows).toEqual([{ key: "join:b", kind: "join", ids: ["b"], warn: true, figure: 4.8, act: { do: "take", clip: "b", take: "x", number: 4, figure: 1.2 } }]);
  });
  it("renders a new take when no other take holds, and waits while the joins are measured", () => {
    const joins = { b: [{ take: "u", in: 4, out: null }, { take: "v", in: 3.5, out: null }] };
    expect(read([rendered("a", ["t"]), rendered("b", ["u", "v"])], joins)[0]!.act).toEqual({ do: "render", clips: ["b"], ms: 60_000 });
    const measuring = read([rendered("a", ["t"]), clip({ id: "b", takes: [take("u", 5)], take: take("u", 5) })]);
    expect(measuring.map((r) => [r.kind, r.figure, r.act])).toEqual([["join", 5, undefined]]);
  });
  it("leaves out joins that hold, cuts and the first clip", () => {
    const rows = read([rendered("a", ["t"]), rendered("b", ["u"]), rendered("c", ["w"], { joined: "cut" })], { a: [{ take: "t", in: 9, out: null }], b: [{ take: "u", in: 3, out: null }], c: [{ take: "w", in: 9, out: null }] });
    expect(rows).toEqual([]);
  });
  it("fills the frame of clips in another aspect ratio", () => {
    expect(read([rendered("a", ["t"]), rendered("b", ["u"])], {}, ["a", "b"])).toEqual([{ key: "shape", kind: "shape", ids: ["a", "b"], warn: false, act: { do: "fill", clips: ["a", "b"] } }]);
  });
});

describe("Fix all", () => {
  it("is offered only once two rows or more have an action", () => {
    const one = read([clip({ id: "a" })]);
    expect(fixAll(one, [], ms)).toBeNull();
  });
  it("patches first, then renders each clip once, in timeline order", () => {
    const clips = [clip({ id: "a", failed: "oom" }), clip({ id: "b" }), rendered("c", ["u", "v"]), rendered("d", ["w"], { join: "stale" })];
    const rows = read(clips, { c: [{ take: "u", in: 5, out: null }, { take: "v", in: 1, out: null }] }, ["d"]);
    // a row that renders b twice over, as two rows could
    rows.push({ key: "again", kind: "missing", ids: ["b"], warn: false, act: { do: "render", clips: ["b"], ms: 60_000 } });
    expect(fixAll(rows, clips, ms)).toEqual({
      patches: [{ clip: "c", patch: { take: "v" } }, { clip: "d", patch: { fill: true } }],
      render: ["a", "b", "d"],
      ms: 180_000,
    });
  });
});

describe("each render's time, as the server plans it", () => {
  // 2 clips left to render and a stale one: the header's plan has the first two, Fix all renders all three
  const clips = [clip({ id: "a" }), clip({ id: "b" }), rendered("c", ["u"], { join: "stale" })];
  const rows = read(clips);
  const fix = fixAll(rows, clips, ms)!;
  it("reads the header's plan for its own clips, and asks for the other sets once", () => {
    const plan = { auto: true, ids: ["b", "a"], ms: 120_000 };
    expect(plansToAsk(rows, fix, plan)).toEqual([["c"], ["a", "b", "c"]]);
    const got = withPlans(rows, fix, plan, [{ ids: ["c"], ms: 50_000 }, { ids: ["a", "b", "c"], ms: 150_000 }]);
    // added up, they said 120 000 and 180 000: the machines share them
    expect(got.rows.map((r) => r.act?.do === "render" && r.act.ms)).toEqual([120_000, 50_000]);
    expect(got.fix?.ms).toBe(150_000);
  });
  it("adds up while a plan is not known, and when a machine is picked", () => {
    const unknown = withPlans(rows, fix, { auto: true, ids: ["a", "b"], ms: 0 }, [{ ids: ["c"], ms: undefined }]);
    expect(unknown.rows.map((r) => r.act?.do === "render" && r.act.ms)).toEqual([120_000, 60_000]);
    expect(unknown.fix?.ms).toBe(180_000);
    const picked = { auto: false, ids: ["a", "b"], ms: 90_000 };
    expect(plansToAsk(rows, fix, picked)).toEqual([]);
    expect(withPlans(rows, fix, picked, []).fix?.ms).toBe(180_000);
  });
});

describe("a row kept as it is", () => {
  it("is the same row while its clips play the same takes, another once one plays another", () => {
    const clips = [rendered("a", ["t1", "t2"]), rendered("b", ["u1"])];
    const row = { key: "shape", kind: "shape" as const, ids: ["a", "b"], warn: false };
    const before = dismissKey(row, clips);
    expect(dismissKey(row, [rendered("a", ["t1", "t2"]), rendered("b", ["u1"])])).toBe(before);
    expect(dismissKey(row, [rendered("a", ["t2", "t1"]), rendered("b", ["u1"])])).not.toBe(before);
  });
  it("never a clip with nothing rendered: there is nothing to keep", () => {
    expect(canDismiss({ key: "missing", kind: "missing", ids: ["a"], warn: false })).toBe(false);
    expect(canDismiss({ key: "join:b", kind: "join", ids: ["b"], warn: true })).toBe(true);
  });
});

describe("a clip whose form is still to fill", () => {
  const why = (c: Clip) => (c.id === "b" ? "Write prompt first." : undefined);
  it("opens its form, said with what it waits for, when none of the clips can render", () => {
    const rows = attention([rendered("a", ["t"]), clip({ id: "b" })], { joins: new Map(), renderable: () => false, msOf: ms, misfit: () => false, why });
    expect(rows.map((r) => [r.kind, r.act])).toEqual([["missing", { do: "open", clip: "b", why: "Write prompt first." }]]);
  });
  it("is left out of Fix all, and does not count towards showing it", () => {
    const clips = [clip({ id: "b" }), rendered("c", ["u"], { join: "stale" })];
    const rows = attention(clips, { joins: new Map(), renderable: (c) => c.id === "c", msOf: ms, misfit: () => false, why });
    expect(rows.map((r) => r.act?.do)).toEqual(["open", "render"]);
    expect(fixAll(rows, clips, ms)).toBeNull();
    // the one row with an action is what "Fix all first" runs
    expect(planFix(rows, clips, ms)).toEqual({ patches: [], render: ["c"] });
  });
});

describe("Needs attention in words", () => {
  const clips = [rendered("a", ["t"]), rendered("b", ["u1", "u2"]), rendered("c", ["w"]), rendered("d", ["x"]), clip({ id: "e" })];
  it("says clip numbers as a list", () => {
    expect(clipWords([5])).toBe("clip 5");
    expect(clipWords([4, 2])).toBe("clips 2 and 4");
    expect(clipWords([1, 2, 6])).toBe("clips 1, 2 and 6");
  });
  it("says Fix all as a full sentence", () => {
    expect(fixWords({ patches: [], render: ["e", "b", "d"] }, clips)).toBe("Renders clips 2, 4 and 5, in order.");
    expect(fixWords({ patches: [{ clip: "b", patch: { take: "u2" } }], render: ["e"] }, clips)).toBe("Plays take 2 on clip 2, then renders clip 5. Each change is its own Undo step.");
    expect(fixWords({ patches: [{ clip: "c", patch: { fill: true } }], render: [] }, clips)).toBe("Fills the frame of clip 3. Each change is its own Undo step.");
  });
  it("says the rows in one line for the Export and Finish dialogs, the joins together", () => {
    const rows: Row[] = [
      { key: "missing", kind: "missing", ids: ["e"], warn: false },
      { key: "join:b", kind: "join", ids: ["b"], warn: true, figure: 5 },
      { key: "join:d", kind: "join", ids: ["d"], warn: true, figure: 20 },
    ];
    expect(attentionLine(rows, clips)).toBe("3 things need attention: clip 5 not rendered, joins at clips 2 and 4");
    expect(attentionLine([{ key: "stale", kind: "stale", ids: ["b"], warn: true }], clips)).toBe("1 thing needs attention: clip before clip 2 changed");
    expect(attentionLine([], clips)).toBe("");
  });
});
