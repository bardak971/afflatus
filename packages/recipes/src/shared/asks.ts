/**
 * The words an instruction model is given before the user's, shared by the families that ask the same thing (card #303): a
 * copy of one ask in each family had already parted (Klein's outpaint lacked "the same camera").
 */

/** The ask, then the user's words after it (none: the ask alone). */
export const withIntro = (intro: string, prompt: string) => [intro, prompt.trim()].filter(Boolean).join(" ");

/**
 * What outpaint asks of the padded picture, before the user's words for the wider scene: the grey is called empty so that
 * it is filled, not drawn as a grey wall, and what is kept is said positively (Qwen reads a "do not" as the thing it names).
 * `picture` names the picture as the model reads it ("<image1>" for Qwen's edits, "this picture" for Klein), `again` the
 * second time.
 */
export const outpaintAsk = (picture: string, again = picture) =>
  `The plain grey areas at the edges of ${picture} are empty. Fill them by continuing the scene naturally beyond its edges: the same place, the same light, the same style and the same camera. Everything already in ${again} stays exactly the same.`;
