/**
 * An error written to be read: the error handler in app.ts sends its message with its status, where an
 * error without a status is a bug, logged and hidden. Every route module throws these.
 */
export const httpError = (message: string, statusCode = 400): Error => Object.assign(new Error(message), { statusCode });

/** "X was not found", as a 404. */
export const notFound = (what: string): Error => httpError(`${what} was not found`, 404);
