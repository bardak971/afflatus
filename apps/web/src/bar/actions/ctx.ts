import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { useOpenInComfy } from "../../actions";
import type { useRentedOps } from "../../rentedOps";
import type { Asset, CommandEntry, Entity, RecipeInfo, RentedState } from "../../api";
import type { useModelSettings, useProjects, useSetup } from "../../data";
import type { useOpenNewDraft } from "../../draft";
import type { FormTarget } from "../../formTarget";
import type { Target } from "../../projects/tree";
import type { usePins } from "../../projects/pins";
import type { useQueueOps } from "../../queueOps";
import type { useTreeActions } from "../../projects/useTreeActions";
import type { useKindActions } from "../../projects/useKindActions";
import type { useQueueBulk } from "../../screens/queue/bulk";
import type { useJobActions } from "../../screens/queue/jobActions";
import type { Banner } from "../../store";
import type { useItemActions } from "../../useItemActions";
import type { SelectedClip, TimelineRequest } from "../bridge";
import type { SettingCtx } from "../settingsRegistry";

/** One thing a result can have done to it: Enter does the first, Ctrl + Enter the second, Tab lists them all. */
export interface Action {
  label: string;
  note?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** The bar stays open after it (a switch flipped in place, a figure copied). */
  stay?: boolean;
  /** The key that does the same where the action comes from (the viewer's menu hint, the editor's key), drawn on its right. */
  keys?: string;
  run(): unknown;
}

/** The timeline a command acts on: the one open in the editor, else the one last used. */
export interface TimelineAim {
  id: string;
  name: string;
  entry?: Extract<CommandEntry, { kind: "timeline" }>;
  /** Open in the editor now (its keys and history are on screen). */
  open?: true;
}

export type TimelineEntry = Extract<CommandEntry, { kind: "timeline" }>;
export type FolderEntry = Extract<CommandEntry, { kind: "folder" }>;
export type Preset = Extract<Entity, { kind: "preset" }>;
export type Person = Extract<Entity, { kind: "person" }>;
export type RenderTimeline = Extract<TimelineRequest, { do: "render" | "render-missing" }>;

/**
 * What the bar's actions are made of: what the app's hooks give (read once in useBarActions, where hooks may be called)
 * and the few steps several kinds of result share. Each file of actions/ takes it and returns plain actions, so that
 * what a kind of result can have done is read in one place.
 */
export interface BarCtx {
  go(to: string): void;
  client: QueryClient;
  say(b: Banner): void;
  tree: ReturnType<typeof useTreeActions>;
  /** The lists of a timeline, a draft, a folder, a project and the Inbox, as every place shows them. */
  kinds: ReturnType<typeof useKindActions>;
  allProjects: NonNullable<ReturnType<typeof useProjects>["data"]>["items"];
  /** The projects not archived. */
  projects: BarCtx["allProjects"];
  pins: ReturnType<typeof usePins>;
  /** What the queue rows need of the queue: not its progress, which changes at every step. */
  queue: {
    paused: boolean; online: boolean; rendering: boolean; running: boolean; waiting: Array<{ id: string }>; failed: string[];
    /** With several ComfyUIs, each one as the per-machine commands read it ("pause studio pc"). */
    machines: Array<{ id: string; name: string; url: string; paused: boolean; online: boolean | null; locked: boolean; running: boolean; rented: RentedState | null }>;
  } | undefined;
  /** The queue's pause, resume, unload and reconnect, as the Queue screen and the status bar have them. */
  ops: ReturnType<typeof useQueueOps>;
  bulk: ReturnType<typeof useQueueBulk>;
  jobs: ReturnType<typeof useJobActions>;
  setup: ReturnType<typeof useSetup>;
  binEmpty: boolean;
  /** What the bin holds, as its strip says it: "3 items · 12 MB". */
  binSaid: string;
  recipes: RecipeInfo[];
  entities: Entity[];
  modelSettings: ReturnType<typeof useModelSettings>;
  openNew: ReturnType<typeof useOpenNewDraft>;
  selectedClip: SelectedClip | null;
  draftOpen: boolean;
  aim: TimelineAim | null;
  subject: Asset | null;
  item: ReturnType<typeof useItemActions>;
  formTarget: FormTarget | null;
  openWorkflow: ReturnType<typeof useOpenInComfy<{ id: string; title: string }>>;
  /** A rented pod's Start and Stop (rentedOps.ts). */
  rented: ReturnType<typeof useRentedOps>;
  /** One machine's ComfyUI page, by its id (actions.ts useOpenComfyUI). */
  openComfy: ReturnType<typeof useOpenInComfy<string>>;
  settingCtx: SettingCtx;
  onCopied(text: string): void;
  setViewing(a: Asset | null): void;
  /** "Import a folder here…": the computer's folder picker, and where what it picks goes. */
  importInto(t: Target): void;

  failed(title: string): (err: unknown) => void;
  good(title: string, text?: string, href?: string, goTo?: string): void;
  noDraft(what?: string): void;
  /** The index read again (a thing made or removed that sends no live event). */
  reindex(): void;
  openDraft(id: string): void;
  /** The open draft's form, opened when it is not on screen. */
  form(): Promise<FormTarget | null>;
  openFolder(id: string, project: string | null): void;
  view(id: string): Promise<void>;
  showInFolder(id: string, project: string | null): Promise<void>;
  askTimeline(t: TimelineAim, request: TimelineRequest): Promise<string[] | null>;
  atTopAction(t: TimelineAim, request: RenderTimeline): Action;
}
