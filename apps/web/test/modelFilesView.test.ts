import { describe, expect, it } from "vitest";
import type { ModelFile, ModelLibrary } from "../src/api";
import { bandOf, figures, lastSaid, NO_FILTER, placeOfId, shown, young } from "../src/screens/settings/modelFilesView";
import { idleSummary, idleWords } from "../src/screens/settings/ModelFilesTab";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const GB = 2 ** 30;

const file = (id: string, o: Partial<ModelFile> = {}): ModelFile => ({
  id, folder: "loras", file: `${id}.safetensors`, kind: "LoRA", size: GB, mtime: NOW - 400 * DAY, sha256: null, name: null, version: null, base: null,
  picture: null, link: null, match: "none", uses: 0, last: null, approx: false, months: {}, takes: 0, copies: [], also: [], needs: [], families: [], path: null, removed: null, ...o,
});

const libOf = (since: string | null, files: ModelFile[]): ModelLibrary => ({
  machine: "pc", readOnly: false, machines: [], files, since, away: { bin: 0, aside: 0, files: 0 }, bin: true, hashing: { files: 0, hashed: 0, running: false }, noFolder: false,
});

// used 2 days ago; used 20 days ago; never used, old on disk; never used, dropped 5 days ago; used 100 days ago (old install only)
const FILES = [
  file("recent", { uses: 4, last: ago(2) }),
  file("month", { uses: 1, last: ago(20) }),
  file("never-old", { size: 10 * GB }),
  file("never-new", { size: 3 * GB, mtime: NOW - 5 * DAY }),
];

describe("Model files on a young install (records 28 days old)", () => {
  const lib = libOf(ago(28), FILES);

  it("counts the files never used by Afflatus in the first figure, with its since", () => {
    expect(young(lib.since, NOW)).toBe(true);
    const f = figures(lib, null, NOW);
    expect(f.idle.never).toBe(true);
    expect(f.idle.files.map((x) => x.id).sort()).toEqual(["never-new", "never-old"]);
    expect(f.idle.bytes).toBe(13 * GB);
    expect(f.idle.filter).toBe("never");
    expect(idleWords(f.idle.never, lib.since, () => "1 Oct")).toBe("never used by Afflatus · since 1 Oct");
  });

  it("puts never-used files in a band of their own, not 8–30 days", () => {
    const bands = Object.fromEntries(figures(lib, null, NOW).bands.map((b) => [b.id, b.bytes]));
    expect(bands).toEqual({ week: GB, month: GB, quarter: 0, idle: 0, never: 13 * GB });
    expect(bandOf(FILES[2]!, lib.since, NOW)).toBe("never");
  });

  it("filters the never-used files, and its Show them shows the same", () => {
    const rows = shown(lib, { ...NO_FILTER, idle: "never", sort: { key: "size", down: true } }, NOW);
    expect(rows.map((x) => x.id)).toEqual(["never-old", "never-new"]);
  });

  it("says never in Last used, its since in the tip", () => {
    const day = (iso: string) => iso.slice(0, 10);
    const old = lastSaid(FILES[2]!, lib.since, day, () => "?");
    expect(old.text).toBe("never");
    expect(old.tip).toContain(`since ${ago(28).slice(0, 10)}`);
    const dropped = lastSaid(FILES[3]!, lib.since, day, () => "?");
    expect(dropped.text).toBe("never");
    expect(dropped.tip).toContain(`here since ${ago(5).slice(0, 10)}`);
    expect(lastSaid(FILES[0]!, lib.since, day, () => "2 d ago")).toEqual({ text: "2 d ago", idle: false });
  });

  it("gives Settings › Models' line the never-used space", () => {
    expect(idleSummary(lib, NOW)).toEqual({ bytes: 13 * GB, files: 2, never: true, since: lib.since });
  });
});

describe("Model files on an old install (records 120 days old)", () => {
  const lib = libOf(ago(120), [...FILES, file("quarter-old", { size: 2 * GB, uses: 3, last: ago(100) })]);

  it("counts the files not used by Afflatus for 90 days, never-used ones here that long among them", () => {
    expect(young(lib.since, NOW)).toBe(false);
    const f = figures(lib, null, NOW);
    expect(f.idle.never).toBe(false);
    expect(f.idle.files.map((x) => x.id).sort()).toEqual(["never-old", "quarter-old"]);
    expect(f.idle.bytes).toBe(12 * GB);
    expect(f.idle.filter).toBe("90");
    expect(idleWords(f.idle.never, lib.since, () => "1 Jul")).toBe("not used by Afflatus for 90 days");
    // its Show them shows what it counts
    expect(shown(lib, { ...NO_FILTER, idle: "90", sort: { key: "size", down: true } }, NOW).map((x) => x.id)).toEqual(["never-old", "quarter-old"]);
  });

  it("keeps the never band apart from the 90+ days band", () => {
    const bands = Object.fromEntries(figures(lib, null, NOW).bands.map((b) => [b.id, b.bytes]));
    expect(bands).toEqual({ week: GB, month: GB, quarter: 0, idle: 2 * GB, never: 13 * GB });
  });

  it("gives Settings › Models' line the 90-day space", () => {
    expect(idleSummary(lib, NOW)).toEqual({ bytes: 12 * GB, files: 2, never: false, since: lib.since });
  });
});

describe("Model files with no job's files kept yet", () => {
  it("has no line in Settings › Models", () => {
    expect(idleSummary(libOf(null, FILES), NOW)).toBeNull();
  });

  it("sorts never-used files as the longest not used", () => {
    const lib = libOf(ago(28), FILES);
    expect(shown(lib, { ...NO_FILTER, sort: { key: "last", down: false } }, NOW).map((x) => x.id).slice(0, 2)).toEqual(["never-old", "never-new"]);
  });
});

describe("a copy's place, from its row id", () => {
  it("is folder/file, with its path for a file under a name another directory's file holds first", () => {
    expect(placeOfId("loras|style/x.safetensors")).toBe("loras/style/x.safetensors");
    expect(placeOfId("loras|x.safetensors|D:/a1111/models/Lora/x.safetensors")).toBe("loras/x.safetensors (D:/a1111/models/Lora/x.safetensors)");
  });
});
