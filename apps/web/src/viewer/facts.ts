/** What the viewer's side says of an item in a line: pure, for the tests. */
import type { Asset, AssetDetail, ClipOf } from "../api";
import { clock, seconds, size, took, when } from "../format";
import { FORMATS } from "./shared";

/** What the item is, in one line: what made it, its size, its file, when, how long it took. `title` is left out when it is already the name. */
export function factsOf(a: Asset, g: AssetDetail["generation"] | null | undefined, title: string): string {
  const timed = a.kind !== "image" && a.durationMs;
  return [
    title,
    a.width && a.height ? `${a.width}×${a.height}` : "",
    // a clip in tenths of a second, a long one as minutes
    timed ? (a.durationMs! < 60_000 ? seconds(a.durationMs!) : clock(a.durationMs!)) : "",
    a.kind === "video" && a.fps ? `${Math.round(a.fps)} fps` : "",
    a.kind === "video" && timed && !a.hasSound ? "silent" : "",
    `${FORMATS[a.mime] ?? a.mime} ${size(a.bytes)}`,
    when(a.createdAt),
    g?.tookMs ? `rendered in ${took(g.tookMs)}` : "",
  ].filter(Boolean).join(" · ");
}

/** The timeline clips it is in: its own (a take of a clip), then those of what was made from it, once each. */
export function placesOf(self: ClipOf | null | undefined, usedIn: Asset[]): Array<{ of: ClipOf; own: boolean }> {
  const out: Array<{ of: ClipOf; own: boolean }> = self ? [{ of: self, own: true }] : [];
  for (const u of usedIn) {
    if (u.clipOf && !out.some((p) => p.of.timeline === u.clipOf!.timeline && p.of.clip === u.clipOf!.clip)) out.push({ of: u.clipOf, own: false });
  }
  return out;
}
