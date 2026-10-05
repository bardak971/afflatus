/** A file sent as a request body, written to a temporary file as it arrived (uploads can be hundreds of megabytes). */
export interface UploadBody {
  path: string;
  /** The temporary folder holding it: removed once the request is answered. */
  dir: string;
  bytes: number;
}
export const isUpload = (body: unknown): body is UploadBody => Boolean(body && typeof body === "object" && "path" in body && "dir" in body);
