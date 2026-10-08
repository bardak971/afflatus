/** The command bar: everything it can find, a render estimate, and the prompts that were rendered (docs/command-bar.md). */

/**
 * One thing the bar can find. `project`: its project's id (resolved through the project entries); null = the Inbox.
 * `folder`: the folder it is in; null when it is at its project's top (in the project's root folder) or loose in the Inbox.
 * `updatedAt`: its last change, else when it was made (an item of the library, a folder: when it was made).
 */
export type CommandEntry =
  | { kind: "timeline"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; clips: number; durationMs: number; exported: boolean; unusedTakes: number; unusedBytes: number }
  | { kind: "draft"; id: string; label: string; project: string | null; updatedAt: string; recipe: string; renders: number }
  | { kind: "asset"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; assetKind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; bytes: number; hasThumb: boolean }
  | { kind: "project"; id: string; label: string; updatedAt: string; archived: boolean; timelines: number; items: number; bytes: number }
  /** A project's root folder is not one: its project stands for it. `parent`: null at the top (or under the root). `items`: its own, not its sub-folders'. */
  | { kind: "folder"; id: string; label: string; project: string | null; parent: string | null; updatedAt: string; items: number; linked: boolean };

export interface CommandIndex {
  entries: CommandEntry[];
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
  createdAt: string;
}

/** The command bar's settings: the shortcut and its optional parts. */
export interface BarSettings {
  /** "Ctrl+K", "Ctrl+Shift+P", "Alt+Space". */
  shortcut: string;
  snippets: boolean;
  history: boolean;
  cast: boolean;
}
