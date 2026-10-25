import { describe, expect, it } from "vitest";
import { h3ReferencePrompt } from "../src/h3/prompt";
import { recipeById } from "../src/index";

const fields = { description: "Nicolas on a café terrace.", soundscape: "", music: "", subject: "Nicolas" };
const prompt = (over: Partial<Parameters<typeof h3ReferencePrompt>[1]>) =>
  h3ReferencePrompt(fields, { roles: ["person", "person", "person"], voice: false, continues: false, opening: false, voiceOnly: false, ...over });

describe("H3's Reference images, as their \"?\" says them", () => {
  it("says on every H3 form taking several that each person picture is the same person, and how to have two (card #75)", () => {
    const notes = ["h3.video", "h3.lipsync", "h3.motion"].map((id) => recipeById(id)!.inputs.find((i) => i.id === "references")?.note);
    for (const note of notes) expect(note).toContain("Every \"A person\" picture is the same person, seen another way. For two people, pin a keyframe that shows both");
    expect(new Set(notes).size).toBe(1);
  });
});

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

describe("H3's reference prompt: a reference video per role (card #86)", () => {
  const video = (role: string, sound = false) => prompt({ roles: [], videos: [{ role, sound }] });

  it("a person's video is <Subject 1>, its sound their voice", () => {
    const p = video("person", true);
    expect(p).toContain("<Subject 1> is the character in <Video 1>, Nicolas.");
    expect(p).toContain("<Audio 1> is the soundtrack of <Video 1>: the voice of <Subject 1> (S1).");
    expect(p).toContain("[reference generation + video reference + audio reference]");
    expect(p).toContain("The setting of [Shot 1]: comes from the description of [Shot 1], never from <Video 1>.");
  });

  it("a place's video is the setting, with how the camera moves through it, and its sound is never said", () => {
    const p = video("place", true);
    expect(p).toContain("<Subject 1> is the location shown in <Video 1>.");
    expect(p).toContain("<Subject 1> (the setting of [Shot 1]): fully_preserved - the place, its layout and light, and how the camera moves through it.");
    expect(p).not.toContain("The setting of [Shot 1]: comes from");
    expect(p).not.toContain("not for the scene");
    expect(p).not.toContain("<Audio");
    expect(p).not.toContain("audio reference");
  });

  it("a look's video: colour, light, rendering, grain and motion feel only, not the scene", () => {
    const p = video("style");
    expect(p).toContain("<Subject 1> is the visual style of <Video 1>.");
    expect(p).toContain("<Subject 1>: attribute_transfer - colour, lighting, rendering style, grain and motion feel only.");
    expect(p).toContain("<Video 1> is a reference for who and what appears, not for the scene");
    expect(p).toContain("The setting of [Shot 1]: comes from the description of [Shot 1], never from <Video 1>.");
  });

  it("clothes' and an object's videos: their look and how they move", () => {
    const clothes = prompt({ roles: ["person"], videos: [{ role: "clothing", sound: true }] });
    expect(clothes).toContain("<Subject 2> is the clothing shown in <Video 1>, worn by <Subject 1>.");
    expect(clothes).toContain("<Subject 2>: fully_preserved - the garments, their colours and materials, and how the cloth moves and sways.");
    expect(clothes).not.toContain("<Audio");
    const object = video("object");
    expect(object).toContain("<Subject 1> is the object shown in <Video 1>.");
    expect(object).toContain("<Subject 1>: fully_preserved - its shape, colour and details, and how it moves.");
  });

  it("the pictures' lines stay as they were: no motion words on a picture", () => {
    const p = prompt({ roles: ["place", "style", "clothing", "object"] });
    expect(p).toContain("fully_preserved - the place, its layout and light.");
    expect(p).toContain("attribute_transfer - colour, lighting and rendering style only.");
    expect(p).toContain("fully_preserved - the garments, their colours and materials.");
    expect(p).toContain("fully_preserved - its shape, colour and details.");
  });

  it("the subjects count the pictures first, then the videos", () => {
    const p = prompt({ roles: ["person", "object"], videos: [{ role: "person", sound: false }, { role: "place", sound: true }] });
    expect(p).toContain("<Subject 1> is the character in <Picture 1> and <Video 1>, Nicolas.");
    expect(p).toContain("<Subject 2> is the object shown in <Picture 2>.");
    expect(p).toContain("<Subject 3> is the location shown in <Video 2>.");
    // a place video sets the scene: no line takes the setting elsewhere, and the person's references keep only who they are
    expect(p).not.toContain("The setting of [Shot 1]: comes from");
    expect(p).toContain("<Picture 1>, <Picture 2> and <Video 1> are references for who and what appears, not for the scene");
  });

  it("says on every H3 form taking them that a video takes a role and only a person's gives its sound", () => {
    for (const id of ["h3.video", "h3.lipsync"]) {
      const spec = recipeById(id)!.inputs.find((i) => i.id === "refVideos");
      expect(spec && spec.type === "references" && spec.roles).toEqual(["person", "place", "clothing", "object", "style"]);
      expect(spec?.note).toContain("short videos of a person, a place, clothes, an object or a look");
    }
    expect(recipeById("h3.video")!.inputs.find((i) => i.id === "refVideos")?.note).toContain("use the music lane or a sound cue");
    expect(recipeById("h3.lipsync")!.inputs.find((i) => i.id === "refVideos")?.note).toContain("Their sound is left out: the recording is the voice");
  });
});
