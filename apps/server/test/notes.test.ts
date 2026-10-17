import { describe, expect, it } from "vitest";
import { notesOf } from "../src/queueStore";
import type { Resume } from "../src/queueModel";

const resume = (outputs: Resume["outputs"]) => ({ outputs }) as unknown as Resume;

describe("a note node's sentences (a swap that found no one to mask)", () => {
  it("are read from the nodes the recipe named as notes, and nothing else", () => {
    const said = notesOf(resume([{ node: "9", kind: "video", role: "result" }, { node: "12", kind: "image", role: "note" }]), {
      "9": { afflatus_note: ["not a note node"] },
      "12": { afflatus_note: ["No one was found in the source video.", "", 3] },
    } as never);
    expect(said).toEqual(["No one was found in the source video."]);
  });

  it("are none when the node said nothing or did not run", () => {
    expect(notesOf(resume([{ node: "12", kind: "image", role: "note" }]), { "12": { afflatus_note: [] } } as never)).toEqual([]);
    expect(notesOf(resume([{ node: "12", kind: "image", role: "note" }]), {} as never)).toEqual([]);
  });
});
