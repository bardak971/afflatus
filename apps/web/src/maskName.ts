import { api } from "./api";

/**
 * A mask is named after the picture it was painted on, so that it is never put on another one. Apart from
 * the painter, so that the form reads it without pulling the painter's chunk in.
 */
export const nameFor = (picture: string) => `mask:${picture}`;

/** A mask painted on `picture` uploaded under its name, kept out of the library: the form's painter and Paint and fix's Fix. */
export const uploadMask = async (picture: string, png: Blob) => api.upload(new File([png], nameFor(picture), { type: "image/png" }), { mask: true });
