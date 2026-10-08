/**
 * A mask is named after the picture it was painted on, so that it is never put on another one. Apart from
 * the painter, so that the form reads it without pulling the painter's chunk in.
 */
export const nameFor = (picture: string) => `mask:${picture}`;
