/** What the drop tray (DropTray.tsx) offers for a file dragged in, worked out apart from the page so that it can be tested. */

export type Kind = "image" | "video" | "audio" | "json" | "other";
export type Zone = "library" | "settings" | "workflow" | "timeline";

/** What is being dragged, told from the first file's type (its name cannot be read until it is dropped); null: no file. */
export function kindOfType(type: string | undefined, hasFiles: boolean): Kind | null {
  if (type === undefined) return hasFiles ? "other" : null;
  return type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : /json/.test(type) ? "json" : "other";
}

/** What a dropped file is, by its type and, where browsers leave the type out, its name. */
export const fileKind = (f: { type: string; name: string }): Kind =>
  f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(f.name) ? "video" : f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a)$/i.test(f.name) ? "audio" : /\.json$/i.test(f.name) || /json/.test(f.type) ? "json" : "other";

/**
 * The places to drop on, for what is dragged: on a timeline's page, also the timeline. Each says what it does in a
 * title and a short line, read at a glance mid-drag; `detail` is the rest, for the tip and screen readers.
 */
export function zonesFor(kind: Kind | null, onTimeline: boolean): Array<{ id: Zone; label: string; hint: string; detail: string }> {
  const zones: Array<{ id: Zone; label: string; hint: string; detail: string }> = [];
  if (!kind) return zones;
  if (kind !== "json") {
    zones.push({
      id: "library", label: "Import to library",
      hint: kind === "audio" ? "Voice sample, clip audio, music" : "Opens in the viewer",
      detail: kind === "audio" ? "To use as a voice sample, a clip's audio or music" : kind === "video" ? "It opens in the viewer: extend it, extract its audio, add it to a timeline" : "It opens in the viewer: img2img, inpaint, i2v, use as a reference image",
    });
  }
  if (onTimeline && kind !== "json") {
    zones.push({
      id: "timeline", label: kind === "audio" ? "Music track of this timeline" : "Add to this timeline",
      hint: kind === "audio" ? "Plays under every clip" : kind === "video" ? "At the end, as it is" : "At the end, as a still",
      detail: kind === "audio" ? "It plays under every clip" : kind === "video" ? "At the end, as it is" : "At the end, as a still. Drop it on a clip instead to make it the clip's first or last frame",
    });
  }
  if (kind === "image" || kind === "other") zones.push({ id: "settings", label: "PNG info", hint: "Its settings into a new form", detail: "Its generation parameters (prompt, checkpoint, LoRAs, sampling settings) fill a new form" });
  if (kind !== "audio") {
    zones.push({
      id: "workflow", label: kind === "json" ? "Import this workflow" : "Import embedded workflow",
      hint: "Added to your workflows",
      detail: kind === "json" ? "It is added to your workflows, to generate with" : "Files saved by ComfyUI carry their workflow: it is added to your workflows, to generate with",
    });
  }
  return zones;
}

/** The workflow a file carries, as a file the import screen can read. */
export const workflowFile = (name: string, workflow: unknown) => new File([JSON.stringify(workflow)], `${name.replace(/\.[^.]+$/, "") || "workflow"}.json`, { type: "application/json" });
