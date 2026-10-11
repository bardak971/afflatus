/** Afflatus's own updates (the server's updates.ts): where it stands, for Settings → About, the rail's dot and the restart. */

/** How Afflatus runs: a release bundle updates itself; Docker and a checkout are told the command. */
export type InstallKind = "bundle" | "docker" | "sources";

/** Where an update stands. `failed` keeps the error until it is tried again or another check comes. */
export type UpdatePhase = "downloading" | "verifying" | "unpacking" | "starting" | "waiting" | "switching" | "restarting" | "failed";

export interface UpdateFlow {
  phase: UpdatePhase;
  /** The version being installed. */
  version: string;
  /** Downloaded so far, of the archive's size (both 0 until it is known). */
  bytes: number;
  total: number;
  /** While waiting: the jobs still to finish before the switch. */
  left: number;
  /** Why it did not go through (phase "failed"), said for the user; the running version is untouched. */
  error: string | null;
}

/** The latest release GitHub gave. */
export interface Release {
  /** Without the tag's "v": "0.4.2". */
  version: string;
  tag: string;
  name: string;
  /** The release's notes as written (Markdown). */
  notes: string;
  /** Its first list lines, for the card. */
  highlights: string[];
  /** The release's page on GitHub. */
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** The text of a "Security: …" line in the notes: the release fixes a security issue, said once in a banner. */
  security: string | null;
}

/** The last update, Go back or move done here, for "Updated today" and the like. */
export interface LastChange {
  kind: "updated" | "went-back" | "moved" | "failed";
  from: string;
  to: string;
  at: string;
  error?: string;
}

export interface UpdatesView {
  /** The version running, as the build names it ("0.4.1", "dev"). */
  version: string;
  install: InstallKind;
  /** The switch in Settings → About (settings.afflatusUpdateChecks). */
  checks: boolean;
  /** The last check that got an answer; null before the first. */
  checkedAt: string | null;
  /** Why the last check got no answer; null when it did. */
  checkError: string | null;
  latest: Release | null;
  /** The latest release is newer than what runs. */
  newer: boolean;
  /** This page is open on the computer Afflatus runs on: Update, Go back and the move are offered only there. */
  here: boolean;
  /** Update can be pressed now. */
  canUpdate: boolean;
  /** Why not, when a newer release cannot be taken in one click (null otherwise). */
  cannot: string | null;
  /** An update under way, or the last one that failed. */
  flow: UpdateFlow | null;
  /** The version before the last update, still installed: Go back returns to it. */
  previous: { version: string; restoresLibrary: boolean } | null;
  last: LastChange | null;
  /** The launcher went back to the previous version because the new one did not start. */
  fallback: { version: string; previous: string; at: string; code: number | null } | null;
  /**
   * A 0.3 library beside this fresh bundle, which the move would bring in: its data folder, its version, its items (out of
   * the bin), timelines and drafts (null when its database could not be read) and the size of its files.
   */
  move: { from: string; version: string; items: number | null; timelines: number | null; drafts: number | null; bytes: number } | null;
}
