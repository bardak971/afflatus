import { describe, expect, it } from "vitest";
import { sentPicture, type Entity } from "../src/api";

/** The picture a cast person's chip shows: the one sent first to a model that takes one (card #220). */
const person = (pictures: string[], order?: string[]): Entity => ({
  id: "p", kind: "person", name: "zz-test", updatedAt: "",
  def: { pictures, voice: null, tags: "", sentence: "", models: {}, outfits: [] },
  ...(order ? { faces: { order, none: [], unread: [] } } : {}),
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
