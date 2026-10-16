import { describe, expect, it } from "vitest";
import type { UpdateFlow, UpdatesView } from "../src/api";
import { aboutState, backFromRestart, goBackQuestion, newsOf, readsAgain, securityNews, stepsOf, versionNote } from "../src/updates";

/** A view as the server answers it: a bundle on this computer, 0.4.1, nothing newer. */
const view = (over: Partial<UpdatesView> = {}): UpdatesView => ({
  version: "0.4.1",
  install: "bundle",
  checks: true,
  checkedAt: "2026-10-12T10:00:00.000Z",
  checkError: null,
  latest: null,
  newer: false,
  here: true,
  canUpdate: false,
  cannot: null,
  flow: null,
  previous: null,
  last: null,
  fallback: null,
  move: null,
  ...over,
});
const release = { version: "0.4.2", tag: "v0.4.2", name: "Afflatus 0.4.2", notes: "- Faster joins", highlights: ["Faster joins"], url: "https://example.test/r", publishedAt: null, prerelease: false, security: null };
const flow = (over: Partial<UpdateFlow> = {}): UpdateFlow => ({ phase: "downloading", version: "0.4.2", bytes: 0, total: 0, left: 0, error: null, ...over });

describe("the Updates part's state", () => {
  it("follows a release's life", () => {
    expect(aboutState(view())).toBe("none");
    expect(aboutState(view({ latest: release, newer: true, canUpdate: true }))).toBe("available");
    expect(aboutState(view({ latest: release, newer: true, flow: flow() }))).toBe("updating");
    expect(aboutState(view({ latest: release, newer: true, flow: flow({ phase: "waiting", left: 2 }) }))).toBe("waiting");
    expect(aboutState(view({ latest: release, newer: true, flow: flow({ phase: "failed", error: "no" }) }))).toBe("failed");
  });

  it("tells Docker, a checkout and another computer rather than offering the button", () => {
    const out = { latest: release, newer: true };
    expect(aboutState(view({ ...out, install: "docker" }))).toBe("docker");
    expect(aboutState(view({ ...out, install: "sources" }))).toBe("sources");
    expect(aboutState(view({ ...out, here: false }))).toBe("elsewhere");
    // the latest release, not newer: nothing to say
    expect(aboutState(view({ latest: release, newer: false, install: "docker" }))).toBe("none");
  });

  it("says Up to date after a check, Updated today after an update to this version", () => {
    const now = new Date("2026-10-12T15:00:00");
    expect(versionNote(view(), now)).toEqual({ text: "Up to date", good: true });
    expect(versionNote(view({ checkedAt: null }), now)).toBeNull();
    expect(versionNote(view({ checkError: "GitHub answered 500" }), now)).toBeNull();
    expect(versionNote(view({ latest: release, newer: true }), now)).toBeNull();
    const last = { kind: "updated" as const, from: "0.4.0", to: "0.4.1", at: new Date("2026-10-12T09:00:00").toISOString() };
    expect(versionNote(view({ last }), now)?.text).toBe("Updated today");
    expect(versionNote(view({ last: { ...last, at: new Date("2026-10-03T09:00:00").toISOString() } }), now)?.text).toBe("Updated 3 Oct");
  });
});

describe("the rail's dot", () => {
  it("names a newer version this browser has not seen in About", () => {
    expect(newsOf(undefined, null)).toBeNull();
    expect(newsOf(view(), null)).toBeNull();
    expect(newsOf(view({ latest: release, newer: true }), null)).toBe("0.4.2");
    expect(newsOf(view({ latest: release, newer: true }), "0.4.2")).toBeNull();
    // seen for an older one: the next is news again
    expect(newsOf(view({ latest: release, newer: true }), "0.4.1")).toBe("0.4.2");
  });

  it("says nothing with the checks off (an answer kept from before), unless Check now was pressed in this page", () => {
    const off = view({ latest: { ...release, security: "zz-test hole" }, newer: true, checks: false });
    expect(newsOf(off, null)).toBeNull();
    expect(securityNews(off, false)).toBeNull();
    expect(newsOf(off, null, true)).toBe("0.4.2");
    expect(securityNews(off, true)?.version).toBe("0.4.2");
    expect(securityNews(view({ latest: release, newer: true }), false)).toBeNull();
  });
});

describe("the updates event", () => {
  it("reads the view again on a change of phase, not on progress", () => {
    expect(readsAgain(flow({ bytes: 10 }), flow({ bytes: 20 }))).toBe(false);
    expect(readsAgain(flow(), flow({ phase: "verifying" }))).toBe(true);
    expect(readsAgain(null, flow())).toBe(true);
    expect(readsAgain(flow(), null)).toBe(true);
    // a check's answer: no flow before or after, the rest of the view may have changed
    expect(readsAgain(null, null)).toBe(true);
  });

  it("knows the server is back from a restart by its new version or a new connection", () => {
    expect(backFromRestart(null, "0.4.2", true)).toBe(false);
    expect(backFromRestart("0.4.1", "0.4.2", false)).toBe(true);
    expect(backFromRestart("0.4.1", "0.4.1", false)).toBe(false);
    // the hello says the build's name, with the tag's v; the view the bare version: the same server, not back yet
    expect(backFromRestart("0.4.1", "v0.4.1", false)).toBe(false);
    expect(backFromRestart("0.4.1", "v0.4.2", false)).toBe(true);
    // the move restarts on the same version
    expect(backFromRestart("0.4.1", "0.4.1", true)).toBe(true);
  });
});

describe("an update's steps", () => {
  it("marks each step done, now or to come, and fills the bar", () => {
    const down = stepsOf(flow({ bytes: 64 * 2 ** 20, total: 128 * 2 ** 20 }), "0.4.1");
    expect(down.steps.map((s) => s.at)).toEqual(["now", "later", "later", "later"]);
    expect(down.steps[0]!.note).toBe("64 of 128 MB");
    expect(down.steps[2]!.label).toBe("Unpacking beside 0.4.1");
    expect(down.steps[3]!.label).toBe("Starting 0.4.2");
    expect(down.done).toBeCloseTo(0.4);
    const unpacking = stepsOf(flow({ phase: "unpacking" }), "0.4.1");
    expect(unpacking.steps.map((s) => s.at)).toEqual(["done", "done", "now", "later"]);
    const switching = stepsOf(flow({ phase: "switching" }), "0.4.1");
    expect(switching.steps.every((s) => s.at === "done")).toBe(true);
    expect(switching.done).toBe(1);
  });
});

describe("Go back's question", () => {
  it("names what keeps billing on RunPod after it, and is not asked while it is refused", () => {
    const billing = ["comfy-5090, stopped: its 50 GB disk, $10.0/month", "volume zz-test (50 GB, $3.50/month)"];
    const q = goBackQuestion("0.4.0", { refused: null, billing, unknown: false })!;
    expect(q.title).toBe("Go back to 0.4.0?");
    expect(q.text).toContain("Still billed on RunPod after it, with no Rented GPUs screen in 0.4.0");
    expect(q.text).toContain(billing.join("; "));
    expect(goBackQuestion("0.4.0", { refused: null, billing: [], unknown: false })!.text).not.toContain("RunPod");
    expect(goBackQuestion("0.4.0", { refused: null, billing: [], unknown: true })!.text).toContain("RunPod did not answer");
    expect(goBackQuestion("0.4.0", { refused: "A rented GPU runs", billing, unknown: false })).toBeNull();
  });

  it("names only the pods its library does not know going back to a version with the Rented GPUs screen (0.5.0 on)", () => {
    expect(goBackQuestion("0.5.0", { refused: null, billing: [], unknown: true })!.text).not.toContain("RunPod");
    const billing = ["zz-test since, stopped: its 20 GB disk, $4.00/month"];
    expect(goBackQuestion("v0.6.1", { refused: null, billing, unknown: false })!.text).toContain(`which the library of v0.6.1 does not know: ${billing[0]}.`);
    expect(goBackQuestion("0.5.0-rc.1", { refused: null, billing, unknown: false })!.text).toContain("no Rented GPUs screen in 0.5.0-rc.1");
  });
});
