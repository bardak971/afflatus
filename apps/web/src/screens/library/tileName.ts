import type { Asset } from "../../api";

/** What each kind of item is called in words. */
export const KIND_WORD = { image: "picture", video: "video", audio: "sound" } as const;

/** What a tile is called: the name it is shown under when its own says nothing, else its name (renders are named), else the draft it came from, else what it is. */
export const tileName = (a: Asset) =>
  a.shownName || a.name || a.draftOf?.name || (a.clipOf ? `${a.clipOf.timelineName} · clip ${a.clipOf.clip}` : KIND_WORD[a.kind][0]!.toUpperCase() + KIND_WORD[a.kind].slice(1));
