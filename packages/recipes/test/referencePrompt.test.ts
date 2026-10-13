import { describe, expect, it } from "vitest";
import { h3ReferencePrompt } from "../src/h3/prompt";

const fields = { description: "Nicolas on a café terrace.", soundscape: "", music: "", subject: "Nicolas" };
const prompt = (over: Partial<Parameters<typeof h3ReferencePrompt>[1]>) =>
  h3ReferencePrompt(fields, { roles: ["person", "person", "person"], voice: false, continues: false, opening: false, voiceOnly: false, ...over });

describe("H3's reference prompt: the pictures say who, never the scene", () => {
  it("references alone: they are not frames, and the setting is the description's", () => {
    const p = prompt({});
    expect(p).toContain("<Picture 1>, <Picture 2> and <Picture 3> are references for who and what appears, not for the scene");
    expect(p).toContain("none of them is a frame of the video");
    expect(p).toContain("The setting of [Shot 1]: comes from the description of [Shot 1], never from <Picture 1>, <Picture 2> and <Picture 3>.");
    expect(p).toContain("only the identity and look are taken from <Picture 1>, <Picture 2> and <Picture 3>, not their background");
  });

  it("references and a first frame: the video opens on the frame, the references stay references", () => {
    const p = prompt({ roles: ["person"], opening: true });
    expect(p).toContain("<Picture 2> is the first frame of [Shot 1]");
    expect(p).toContain("<Picture 1> is a reference for who and what appears, not for the scene");
    expect(p).toContain("The setting of [Shot 1]: comes from <Picture 2>, never from <Picture 1>.");
  });

  it("a place picture is the setting itself: no line takes it away", () => {
    const p = prompt({ roles: ["person", "place"] });
    expect(p).toContain("<Subject 2> (the setting of [Shot 1])");
    expect(p).not.toContain("The setting of [Shot 1]: comes from");
    expect(p).toContain("<Picture 1> is a reference for who and what appears");
    expect(p).not.toContain("<Picture 2> is a reference for");
  });

  it("a voice with the picture of who speaks: that picture is the setting too, as before", () => {
    const p = prompt({ roles: ["person"], voice: true, voiceOnly: true });
    expect(p).toContain("setting too");
    expect(p).not.toContain("not for the scene");
    expect(p).not.toContain("The setting of [Shot 1]: comes from");
  });

  it("a clip that carries on: the setting carries on from its frames", () => {
    expect(prompt({ continues: true })).toContain("The setting of [Shot 1]: comes from the given opening frames");
  });
});
