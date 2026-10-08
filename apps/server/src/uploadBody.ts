/** A file sent as a request body, written to a temporary file as it arrived (uploads can be hundreds of megabytes). */
export interface UploadBody {
  path: string;
  /** The temporary folder holding it: removed once the request is answered. */
  dir: string;
  bytes: number;
}

// the bodies the upload parser made: a JSON body of the same shape is not in here, so it can never name a file to read or a folder to remove
const uploads = new WeakSet<object>();

/** Marks a body as one the upload parser wrote (only the content-type parser in app.ts calls this). */
export function uploadBody(body: UploadBody): UploadBody {
  uploads.add(body);
  return body;
}

export const isUpload = (body: unknown): body is UploadBody => typeof body === "object" && body !== null && uploads.has(body);
