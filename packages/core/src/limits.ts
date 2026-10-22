/**
 * How much a look and a person may hold: the server refuses more, and the forms stop offering more
 * at the same count, so that a save never fails on it.
 */
/**
 * How long an item nobody kept has before it goes to the bin: a day from when its countdown started. One figure for
 * the server's sweep, which bins it then, and the library's tiles, which count down to it.
 */
export const UNKEPT_MS = 24 * 60 * 60_000;

export const LIMITS = {
  /** People and places in one look. */
  cast: 8,
  /** Snippets ticked in one look. */
  snippets: 30,
  /** Reference pictures of one person or place. */
  pictures: 9,
  /** Of those, how many a model that takes reference pictures is handed: the first ones (a person's first is the face). */
  sentPictures: { person: 3, place: 2 },
  /** Outfits of one person. */
  outfits: 30,
  /** Fields pinned to the top of one model family's forms (Pinned fields). */
  pinnedFields: 60,
} as const;
