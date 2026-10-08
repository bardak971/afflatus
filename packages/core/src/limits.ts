/**
 * How much a look and a person may hold: the server refuses more, and the forms stop offering more
 * at the same count, so that a save never fails on it.
 */
export const LIMITS = {
  /** People and places in one look. */
  cast: 8,
  /** Snippets ticked in one look. */
  snippets: 30,
  /** Reference pictures of one person or place. */
  pictures: 9,
  /** Outfits of one person. */
  outfits: 30,
} as const;
