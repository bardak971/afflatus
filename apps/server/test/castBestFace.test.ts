import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { InputSpec } from "@afflatus/core";
import { recipeById, recipes } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { compose, kitList } from "../src/entities";
import { bestFirst, frontalOf, qualityOf, sentOrder, type FaceFacts } from "../src/faceFacts";
import { newAssetRow } from "../src/media";
import { makeApp, type TestApp } from "./helpers";

/**
 * A cast person's pictures go clearest face first (card #220): a model that takes one picture of them (Krea 2's person
 * reference) is sent their best face, not the first of the kit; one picked in the form wins. The faces are read by the
 * node pack's route on a machine that renders nothing, once per picture.
 */

/** Five points of a face whose eyes are `eyes` apart at (x, y), the nose moved sideways by `turn` of that distance. */
const points = (x: number, y: number, eyes: number, turn = 0): Array<[number, number]> => [
  [x - eyes / 2, y], [x + eyes / 2, y], [x + turn * eyes, y + eyes * 0.55], [x - eyes * 0.4, y + eyes], [x + eyes * 0.4, y + eyes],
];

/** A unit embedding mostly along `axis`, a little along the next one: pictures of one person share an axis. */
const embedding = (axis: number, lean = 0.2): number[] => {
  const v = Array.from({ length: 16 }, (_, i) => (i === axis ? 1 : i === (axis + 1) % 16 ? lean : 0));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

const fact = (o: { height?: number; turn?: number; sharp?: number; axis?: number; lean?: number } = {}): FaceFacts => {
  const h = o.height ?? 400;
  return {
    version: 1, width: 1024, height: 1536, faces: 1,
    face: { box: [300, 300, 300 + h * 0.8, 300 + h], points: points(300 + h * 0.4, 300 + h * 0.4, h * 0.4, o.turn ?? 0), score: 0.9, sharp: o.sharp ?? 300, embedding: embedding(o.axis ?? 0, o.lean ?? 0.2) },
  };
};
const noFace: FaceFacts = { version: 1, width: 1024, height: 1536, faces: 0, face: null };

describe("how good a reference a face is", () => {
  it("reads a face looking at the camera as frontal, a tilted head too, a turned one less", () => {
    expect(frontalOf(points(100, 100, 40))).toBeCloseTo(1);
    // the same face tilted 30°: a tilt is no worse a reference
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    expect(frontalOf(points(100, 100, 40).map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]))).toBeCloseTo(1);
    expect(frontalOf(points(100, 100, 40, 0.25))).toBeLessThan(0.6);
    expect(frontalOf(points(100, 100, 40, 0.5))).toBe(0);
  });

  it("counts a small, a soft or a turned face for less", () => {
    expect(qualityOf(fact())).toBe(1);
    expect(qualityOf(fact({ height: 64 }))).toBeCloseTo(0.25);
    expect(qualityOf(fact({ sharp: 15 }))).toBeLessThan(0.4);
    expect(qualityOf(fact({ turn: 0.3 }))).toBeLessThan(0.6);
    expect(qualityOf(noFace)).toBe(0);
  });
});

describe("a person's pictures, clearest face first", () => {
  it("puts the good face most like their other pictures first, ahead of a large selfie unlike them", () => {
    // the #219 case: the first picture a large, sharp, frontal selfie in coloured light (unlike the others), the second as
    // good and like the others
    const known = new Map([["selfie", fact({ axis: 5, lean: 1 })], ["good", fact()], ["far", fact({ height: 120 })], ["side", fact({ turn: 0.2, lean: 0.3 })]]);
    expect(bestFirst(["selfie", "good", "far", "side"], known)[0]).toBe("good");
  });

  it("puts a picture with no face found last, and those not read yet before it in the kit's order", () => {
    const known = new Map([["blank", noFace], ["face", fact({ height: 150 })]]);
    expect(bestFirst(["blank", "new1", "face", "new2"], known)).toEqual(["face", "new1", "new2", "blank"]);
  });

  it("keeps the kit's order when nothing is read, and between pictures of the same worth", () => {
    expect(bestFirst(["a", "b", "c"], new Map())).toEqual(["a", "b", "c"]);
    expect(bestFirst(["a", "b"], new Map([["a", fact()], ["b", fact()]]))).toEqual(["a", "b"]);
    expect(bestFirst(["b", "a"], new Map([["a", fact()], ["b", fact()]]))).toEqual(["b", "a"]);
  });

  it("sends the picture picked in the form first, and leaves aside a pick that is not theirs any more", () => {
    expect(sentOrder(["good", "selfie", "far"], "far")).toEqual(["far", "good", "selfie"]);
    expect(sentOrder(["good", "selfie"], "gone")).toEqual(["good", "selfie"]);
    expect(sentOrder(["good", "selfie"], null)).toEqual(["good", "selfie"]);
  });
});

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function picture(name: string): Promise<string> {
  const id = newId();
  const key = `assets/zz/${id}`;
  await t!.services.storage.put(key, new Uint8Array(await sharp({ create: { width: 64, height: 96, channels: 3, background: "#888" } }).png().toBuffer()));
  await t!.db.insertInto("assets").values(newAssetRow({ id, kind: "image", origin: "uploaded", name, file_key: key, thumb_key: null, mime: "image/png", bytes: 1, width: 64, height: 96, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now() })).execute();
  return id;
}

async function person(name: string, pictures: string[]): Promise<string> {
  const id = newId();
  await t!.db.insertInto("entities").values({ id, owner_id: OWNER, kind: "person", name, def: JSON.stringify({ pictures, sentence: "zz-test" }), created_at: now(), updated_at: now() }).execute();
  return id;
}

const read = (asset: string, f: FaceFacts) => t!.db.insertInto("face_facts").values({ asset_id: asset, version: 1, facts: JSON.stringify(f), read_at: now() }).execute();

describe("the forms send a cast person's clearest face", () => {
  let selfie: string;
  let good: string;
  let far: string;
  let who: string;
  beforeEach(async () => {
    t = await makeApp();
    selfie = await picture("selfie.png");
    good = await picture("good.png");
    far = await picture("far.png");
    who = await person("zz-test Nicolas", [selfie, good, far]);
    await read(selfie, fact({ axis: 5, lean: 1 }));
    await read(good, fact());
    await read(far, fact({ height: 100 }));
  });

  it("gives Krea 2's person reference, which takes one picture, their clearest face rather than their first", async () => {
    const { input, added } = await compose(t!.db, recipeById("krea2.text-to-picture")!, { prompt: "zz-test" }, { cast: [{ id: who }], snippets: [] });
    expect(input.person).toEqual([{ asset: good, role: "person" }]);
    expect(added.refs).toEqual([{ asset: good, role: "person", from: "zz-test Nicolas" }]);
  });

  it("gives a model that takes several pictures of a person their clearest face first", async () => {
    const several = recipes.find((r) => (r.inputs as InputSpec[]).some((i) => i.type === "references" && !i.media && !i.subjects && i.max >= 3 && i.roles.includes("person")))!;
    const refId = (several.inputs as InputSpec[]).find((i) => i.type === "references" && !i.media)!.id;
    const { input } = await compose(t!.db, several, { prompt: "zz-test" }, { cast: [{ id: who }], snippets: [] });
    expect((input[refId] as Array<{ asset: string }>).map((r) => r.asset)).toEqual([good, far, selfie]);
  });

  it("sends the picture picked in the form instead", async () => {
    const { input } = await compose(t!.db, recipeById("krea2.text-to-picture")!, { prompt: "zz-test" }, { cast: [{ id: who, picture: far }], snippets: [] });
    // neither their first nor their clearest: the one picked
    expect(input.person).toEqual([{ asset: far, role: "person" }]);
  });

  it("says in the kit's list which picture goes first, and which are not read yet", async () => {
    const fresh = await picture("new.png");
    await t!.db.updateTable("entities").set({ def: JSON.stringify({ pictures: [selfie, fresh, good, far], sentence: "zz-test" }) }).where("id", "=", who).execute();
    const item = (await kitList(t!.services, "person")).find((e) => e.id === who)!;
    expect(item.faces).toEqual({ order: [good, far, selfie, fresh], none: [], unread: [fresh] });
  });
});

describe("the faces read in the background", () => {
  let fake: FakeComfy;
  let asked: number;
  beforeEach(async () => {
    fake = await startFakeComfy();
    fake.packVersion = "0.48.1";
    asked = 0;
    // the pretend pack: a face in every picture but the third one asked
    fake.faceFacts = () => (++asked === 3 ? noFace : fact());
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("reads the kit's people's pictures once each, on a machine that renders nothing, a few at a time", async () => {
    const pics = await Promise.all(["a", "b", "c", "d", "e"].map((n) => picture(`${n}.png`)));
    await person("zz-test A", pics.slice(0, 3));
    await person("zz-test B", pics.slice(2));
    expect(await t!.services.faces!.run()).toBe(4);
    expect(await t!.services.faces!.run()).toBe(1);
    expect(await t!.services.faces!.run()).toBe(0);
    expect(asked).toBe(5);
    const rows = await t!.db.selectFrom("face_facts").select(["asset_id", "facts"]).execute();
    expect(rows.map((r) => r.asset_id).sort()).toEqual([...pics].sort());
    expect(JSON.parse(rows.find((r) => r.asset_id === pics[2])!.facts).face).toBeNull();
    // sent as a picture of the route's size at most, as a JPEG
    expect(fake.calls.filter((c) => c === "POST /afflatus/face-facts")).toHaveLength(5);
  });

  it("waits while the machine renders, Afflatus's work or anyone's", async () => {
    await person("zz-test A", [await picture("a.png")]);
    fake.running = ["someone-else"];
    expect(await t!.services.faces!.run()).toBe(0);
    fake.running = [];
    fake.pending = ["queued"];
    expect(await t!.services.faces!.run()).toBe(0);
    fake.pending = [];
    expect(await t!.services.faces!.run()).toBe(1);
  });

  it("asks nothing of a machine whose pack is older or has no route, and keeps the kit's order there", async () => {
    const pics = [await picture("a.png"), await picture("b.png")];
    const who = await person("zz-test A", pics);
    fake.packVersion = "0.48.0";
    expect(await t!.services.faces!.run()).toBe(0);
    fake.packVersion = "0.48.1";
    fake.faceFacts = undefined;
    expect(await t!.services.faces!.run()).toBe(0);
    expect(asked).toBe(0);
    const { input } = await compose(t!.db, recipeById("krea2.text-to-picture")!, { prompt: "zz-test" }, { cast: [{ id: who }], snippets: [] });
    expect(input.person).toEqual([{ asset: pics[0], role: "person" }]);
  });
});
