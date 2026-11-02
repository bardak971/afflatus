import { describe, expect, it } from "vitest";
import { sentFirstSaid, sentPicture, type Entity } from "../src/api";

/** The picture a cast person's chip shows: the one sent first to a model that takes one (card #220). */
const person = (pictures: string[], order?: string[], read: { none?: string[]; unread?: string[] } = {}): Entity => ({
  id: "p", kind: "person", name: "zz-test", updatedAt: "",
  def: { pictures, voice: null, tags: "", sentence: "", models: {}, outfits: [] },
  ...(order ? { faces: { order, none: read.none ?? [], unread: read.unread ?? [] } } : {}),
});

describe("the picture sent first of a cast person", () => {
  it("is their clearest face, as the server orders their pictures, not their first", () => {
    expect(sentPicture(person(["selfie", "good"], ["good", "selfie"]))).toBe("good");
  });

  it("is the one picked in the form while it is still theirs", () => {
    expect(sentPicture(person(["selfie", "good", "far"], ["good", "far", "selfie"]), "far")).toBe("far");
    expect(sentPicture(person(["selfie", "good"], ["good", "selfie"]), "gone")).toBe("good");
  });

  it("is their first until their pictures are read", () => {
    expect(sentPicture(person(["selfie", "good"]))).toBe("selfie");
  });
});

describe("what the chip says of the picture sent first", () => {
  it("says the clearest face only of a picture read with a face (card #233)", () => {
    expect(sentFirstSaid(person(["selfie", "good"], ["good", "selfie"]), "good")).toBe("Sent first: the clearest face");
    expect(sentFirstSaid(person(["selfie", "good"], ["good", "selfie"]), "good", "good")).toBe("Sent first: picked here");
    // none read yet: the server's order is the kit's, and its first is no clearest face
    expect(sentFirstSaid(person(["selfie", "good"], ["selfie", "good"], { unread: ["selfie", "good"] }), "selfie")).toBe("Sent first: the first of the Prompt kit (not read for faces yet)");
    expect(sentFirstSaid(person(["selfie", "good"], ["selfie", "good"], { none: ["selfie", "good"] }), "selfie")).toBe("Sent first: the first of the Prompt kit (no face found in their pictures)");
    expect(sentFirstSaid(person(["selfie"]), "selfie")).toBe("Sent first: the first of the Prompt kit (not read for faces yet)");
  });
});
