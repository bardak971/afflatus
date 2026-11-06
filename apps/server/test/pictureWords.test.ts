import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { AI_COMMENT, AI_SOURCE_TYPE } from "../src/aiMark";
import { readEmbedded } from "../src/embedded";
import { exifBlock, jpegLayout, pictureOut, webpChunks } from "../src/pictureWords";

/** A JPEG's and a WebP's words as they leave (pictureWords.ts, review 2026-11-05b N3): gone, the pixels the same. */

const PARAMS = "a lighthouse at dusk\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 64x48, Model: illustrious";
const base = () => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 10 } } });

/** A JPEG segment of this marker and data. */
const segment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};

/**
 * A phone's photo as A1111 would have saved it: EXIF with a GPS place, a camera serial and A1111's UserComment, an XMP
 * packet, a comment, a Photoshop block, and a trailer past its end; turned on its side by its orientation.
 */
async function wordyJpeg(progressive = false): Promise<Buffer> {
  const jpeg = await base().jpeg({ progressive }).withIccProfile("p3").withExif({ IFD0: { Make: "PhoneCo", Orientation: "6" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2/1" } }).toBuffer();
  const l = jpegLayout(jpeg)!;
  // A1111's EXIF first, where the readers look (the same orientation in it), the camera's after
  const a1111 = segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifBlock({ orientation: 6, comment: PARAMS })!]));
  const words = [
    segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>C:\\Users\\someone\\shot.psd</x:xmpmeta>", "utf8")),
    segment(0xed, Buffer.from("Photoshop 3.0\0serial 1234", "latin1")),
    segment(0xfe, Buffer.from("taken at home", "latin1")),
  ];
  return Buffer.concat([jpeg.subarray(0, 2), a1111, jpeg.subarray(2, l.scan), ...words, jpeg.subarray(l.scan), Buffer.from("SEFT trailer: home 48.85,2.35")]);
}

const pixels = async (b: Uint8Array) => sharp(Buffer.from(b)).raw().toBuffer();
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("a JPEG on its way out", () => {
  it("keeps none of the words it came with, the switch off: its pixels, colour profile and orientation the same", async () => {
    for (const progressive of [false, true]) {
      const jpeg = await wordyJpeg(progressive);
      // the photo says all of it as it was stored
      expect((await readEmbedded(jpeg)).settings?.prompt).toBe("a lighthouse at dusk");
      expect((await sharp(jpeg).metadata()).orientation).toBe(6);
      expect((await sharp(jpeg).metadata()).icc).toBeDefined();
      const out = pictureOut(jpeg, { mark: false });
      expect(text(out)).not.toMatch(/PhoneCo|lighthouse|someone|serial|taken at home|SEFT|ns\.adobe\.com/);
      expect((await sharp(Buffer.from(out)).metadata()).exif?.toString("latin1")).not.toMatch(/GPS|PhoneCo/);
      expect((await readEmbedded(out)).settings).toBeNull();
      expect((await sharp(Buffer.from(out)).metadata()).orientation).toBe(6);
      expect((await sharp(Buffer.from(out)).metadata()).icc).toEqual((await sharp(jpeg).metadata()).icc);
      expect(await pixels(out)).toEqual(await pixels(jpeg));
      expect(text(out)).not.toContain(AI_COMMENT);
    }
  });

  it("a render's carries the mark, and its parameters in EXIF read back as A1111's", async () => {
    const out = pictureOut(await wordyJpeg(), { mark: true, texts: { parameters: PARAMS, afflatus: "{}" } });
    expect(Buffer.from(out).toString("utf8")).toContain(AI_SOURCE_TYPE);
    expect(text(out)).toContain(AI_COMMENT);
    expect(text(out)).not.toMatch(/PhoneCo|someone|SEFT/);
    const back = await readEmbedded(out);
    expect(back.settings).toMatchObject({ source: "a1111", prompt: "a lighthouse at dusk", negative: "lowres", steps: 20, seed: 42 });
    expect(await pixels(out)).toEqual(await pixels(await wordyJpeg()));
    // a text past what a segment holds goes without it, the mark kept
    const long = pictureOut(await wordyJpeg(), { mark: true, texts: { parameters: `${"é".repeat(40_000)}\nSteps: 1` } });
    expect(text(long)).toContain(AI_COMMENT);
    expect((await readEmbedded(long)).settings).toBeNull();
  });

  it("comes back as it was when it cannot be walked whole", async () => {
    const jpeg = await wordyJpeg();
    const cut = jpeg.subarray(0, 300);
    expect(Buffer.from(pictureOut(cut, { mark: false })).equals(cut)).toBe(true);
  });
});

describe("a WebP on its way out", () => {
  const ids = (b: Uint8Array) => [...webpChunks(Buffer.from(b))].map((c) => c.id);

  it("drops its EXIF and XMP, the switch off, its flags saying so and its pixels the same", async () => {
    const webp = await base().webp().withExif({ IFD0: { Make: "PhoneCo" }, IFD2: { UserComment: "secret words" } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">C:\\Users\\someone</x:xmpmeta>').toBuffer();
    expect(ids(webp)).toEqual(expect.arrayContaining(["VP8X", "EXIF", "XMP "]));
    const out = pictureOut(webp, { mark: false });
    expect(ids(out)).not.toContain("EXIF");
    expect(ids(out)).not.toContain("XMP ");
    expect(text(out)).not.toMatch(/PhoneCo|secret|someone/);
    expect(Buffer.from(out)[20]! & 0x0c).toBe(0);
    const meta = await sharp(Buffer.from(out)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(await pixels(out)).toEqual(await pixels(webp));
  });

  it("a plain render's takes a VP8X, the mark and its parameters, lossy or lossless with alpha", async () => {
    const lossy = await base().webp().toBuffer();
    const alpha = await sharp({ create: { width: 33, height: 17, channels: 4, background: { r: 0, g: 90, b: 200, alpha: 0.5 } } }).webp({ lossless: true }).toBuffer();
    for (const webp of [lossy, alpha]) {
      expect(ids(webp)).not.toContain("VP8X");
      const out = pictureOut(webp, { mark: true, texts: { parameters: PARAMS } });
      expect(ids(out)).toEqual(["VP8X", ids(webp)[0], "EXIF", "XMP "]);
      expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8);
      const meta = await sharp(Buffer.from(out)).metadata();
      expect(meta.xmp?.toString("utf8")).toContain(AI_SOURCE_TYPE);
      expect([meta.width, meta.height]).toEqual([(await sharp(webp).metadata()).width, (await sharp(webp).metadata()).height]);
      expect(meta.hasAlpha).toBe(webp === alpha);
      expect((await readEmbedded(out)).settings).toMatchObject({ prompt: "a lighthouse at dusk", seed: 42 });
      expect(await pixels(out)).toEqual(await pixels(webp));
    }
  });
});
