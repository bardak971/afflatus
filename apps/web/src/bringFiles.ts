import { api } from "./api";
import type { Banner } from "./store";

/** Where files brought in land: a folder, or none (the Inbox); `made` when a project's root folder was made for them first. */
export type Landing = { folder: string | null; made: boolean };

/**
 * Files dropped from the computer onto a place of the library: the one way the folder panel and the
 * Projects panel bring them in. Pictures, videos and sounds are uploaded, three at a time; what is none
 * of them, and folders (which a drop does not read), are left out and said. Onto a linked folder the
 * server writes each file into its directory on disk (never over another file) and lists it there.
 * One banner says how many came in, how many failed and why, and what was left out.
 */
export async function bringFiles(files: File[], o: {
  /** The place's name, for the banner. */
  name: string;
  /** Folders among what was dropped (counted apart from the files). */
  folders?: number;
  /** A folder of the disk: said in the banner. */
  onDisk?: boolean;
  /** Where they go, asked once there is something to upload; undefined when that failed (already said). */
  landing(): Promise<Landing | undefined>;
  say(b: Banner): void;
  /** After the uploads, whatever came of them. */
  done?(added: number, at: Landing): void;
  /** Where the banner's link leads. */
  act?(): void;
}): Promise<void> {
  const folders = o.folders ?? 0;
  const media = files.filter((f) => /^(image|video|audio)\//.test(f.type));
  const left = files.length - media.length - folders;
  const skipped = [folders && `${folders === 1 ? "a folder" : `${folders} folders`} (use Import a folder… on its right-click menu)`, left > 0 && `${left} file${left === 1 ? "" : "s"} that ${left === 1 ? "is" : "are"} no picture, video or sound`].filter(Boolean).join(" and ");
  const id = `bring:${Date.now()}`;
  if (!media.length) {
    o.say({ id, tone: "bad", title: `Nothing to add to ${o.name}`, text: skipped ? `Left out: ${skipped}.` : undefined, href: "/", go: "Open the Studio" });
    return;
  }
  const at = await o.landing();
  if (!at) return;
  let failed = 0;
  // the server's reasons, each once: a read-only or full disk says the same for every file
  const why = new Set<string>();
  const queue = [...media];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        await api.upload(f, at.folder ? { folder: at.folder } : { project: null });
      } catch (err) {
        failed++;
        why.add(err instanceof Error ? err.message : String(err));
      }
    }
  }));
  const added = media.length - failed;
  o.done?.(added, at);
  o.say({
    id, tone: failed ? "bad" : "good", title: `${failed ? `${added} of ${media.length}` : added} file${media.length === 1 ? "" : "s"} added to ${o.name}`,
    text: [
      at.made && `${o.name} has a root folder now: they are in it.`,
      o.onDisk && added > 0 && "Written into the folder on your disk.",
      failed && `${failed} failed: ${[...why].slice(0, 2).join(" ")}`,
      skipped && `Left out: ${skipped}.`,
    ].filter(Boolean).join(" ") || undefined,
    href: "/", go: o.act ? "Open it" : "Open the Studio", ...(o.act ? { act: o.act } : {}),
  });
}
