/** The command bar: everything it can find (the library, timelines, drafts, projects, folders, workflows, the Prompt kit), a render estimate, and the prompts that were rendered (docs/command-bar.md). */

/**
 * One thing the bar can find. `project`: its project's id (resolved through the project entries); null = the Inbox.
 * `folder`: the folder it is in; null when it is at its project's top (in the project's root folder) or loose in the Inbox.
 * `updatedAt`: its last change, else when it was made (an item of the library, a folder: when it was made).
 */
export type CommandEntry =
  | { kind: "timeline"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; clips: number; durationMs: number; plannedMs: number; exported: boolean; unusedTakes: number; unusedBytes: number }
  /**
   * `prompt`: the start of what was written, when a name of its own is the label. `createdAt`: missing from a server before it was sent.
   * `models`: the families it was rendered with, the newest first (missing from a server before it was sent).
   */
  | { kind: "draft"; id: string; label: string; project: string | null; updatedAt: string; createdAt?: string; recipe: string; renders: number; prompt?: string; models?: string[] }
  | { kind: "asset"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; assetKind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; bytes: number; hasThumb: boolean; inBin?: true }
  | { kind: "project"; id: string; label: string; updatedAt: string; archived: boolean; timelines: number; items: number; bytes: number }
  /** A project's root folder is not one: its project stands for it. `parent`: null at the top (or under the root). `items`: its own, not its sub-folders'. */
  | { kind: "folder"; id: string; label: string; project: string | null; parent: string | null; updatedAt: string; items: number; linked: boolean }
  /** An imported ComfyUI workflow. `problem`: it cannot be built as it is mapped (still listed, to be mended or removed). */
  | { kind: "workflow"; id: string; label: string; updatedAt: string; output: "image" | "video" | "audio"; problem: boolean }
  /** An entry of the Prompt kit. `shipped`: a preset that ships with Afflatus (applied or copied, never changed). */
  | { kind: "kit"; id: string; label: string; updatedAt: string; entity: "person" | "place" | "style" | "preset" | "snippet"; shipped: boolean };

export interface CommandIndex {
  entries: CommandEntry[];
  /** How many of the library's items are in no project (the index holds only a few items: their count is said apart). */
  inboxItems: number;
}

/** What rendering would take, learned from this machine's renders; `ms: null` when nothing like it was rendered yet. */
export interface CommandEstimate {
  ms: number | null;
  /** How many past renders it is learned from. */
  basis: number;
  /** The jobs waiting or running before it. */
  ahead: number;
}

export interface PromptHistoryItem {
  prompt: string;
  recipe: string;
  draftId: string | null;
  /** Its first output still in the library; null when none is. */
  assetId: string | null;
  /** The timeline clip that output is a take of; null for a render of a draft. */
  clip: { timeline: string; clip: number } | null;
  createdAt: string;
}

/** The command bar's settings: the shortcut and its optional parts. */
export interface BarSettings {
  /** "Ctrl+K", "Ctrl+Shift+P", "Alt+Space". */
  shortcut: string;
  snippets: boolean;
  cast: boolean;
}
