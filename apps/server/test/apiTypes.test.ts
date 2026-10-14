import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
// the web's shapes of the server's answers (apps/web/src/api/types), as the page reads them
import type { Asset, AssetDetail, ClipOf, ProjectsTree } from "../../web/src/api/types/library";
import type { HistoryPage, QueueStatus, RenderItem, TimesSummary as WebTimes } from "../../web/src/api/types/queue";
import type { ClipPatch, Measure as WebMeasure, Timeline, TimelinePatch } from "../../web/src/api/types/timeline";
import type { Draft, DraftBrief, DraftPatch, Entity, PresetFilesView as WebPresetFiles } from "../../web/src/api/types/designer";
import type { Settings as WebSettings, SettingsPatch } from "../../web/src/api/types/settings";
import type { CommandEntry as WebEntry, CommandEstimate as WebEstimate, CommandIndex, PromptHistoryItem as WebPromptItem } from "../../web/src/api/types/bar";
import type { Download } from "../../web/src/api/types/models";
import type { UpdatesView as WebUpdates } from "../../web/src/api/types/updates";
import type { LibraryChange as WebLibraryChange } from "../../web/src/queryKeys";
// the server's own: what its routes return
import type { assetDetail } from "../src/assets-api";
import type { CommandEntry, CommandEstimate, commandIndex, commandItems } from "../src/commandIndex";
import type { Measure } from "../src/cut";
import type { DownloadView } from "../src/downloads";
import type { DraftView, draftsList, saveBody } from "../src/drafts";
import type { EntityView } from "../src/entities";
import type { LibraryChange } from "../src/events";
import type { assetView } from "../src/media";
import type { PresetFilesView } from "../src/presetFiles";
import type { projectsTree } from "../src/projects";
import type { PromptHistoryItem } from "../src/promptHistory";
import type { Queue } from "../src/queue";
import type { history } from "../src/queueView";
import type { list, TimesSummary } from "../src/rendersRead";
import type { llmSchema, publicSettings, settingsSchema } from "../src/settings";
import type { Timelines } from "../src/timelines";
import type { clipPatch, timelinePatch } from "../src/timelines-api";
import type { UpdatesView } from "../src/updates";
import type { DeployModelsView } from "../src/deployModels";
import type { ModelSetView, SetFileView } from "../src/modelSets";
import type { DeployModels, ModelSet, SetFile } from "../../web/src/api/types/models";

/**
 * The web keeps its own copy of the shapes the server answers with (it imports nothing from the server), so a field
 * renamed on one side would break the page only when it runs. Here each main answer is held against its web shape, at
 * the type level (`npm run typecheck` compiles this file; running it checks nothing more):
 * - what the server returns must fit what the web declares (a field the web needs and the server no longer sends, or
 *   sends as another type, fails);
 * - and every key the web declares, optional ones and nested ones included, must be one the server has (`Unknown`):
 *   an optional field renamed on either side fits the first check but not this one.
 * Keys the server sends and the web does not read are fine. Where a web shape is shared by several answers (an item
 * in a listing has `clipOf`, a bare one does not), the keys only the other answer has are named and left out here.
 */

type KeysOf<T> = T extends unknown ? keyof T : never;
type At<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
/**
 * The paths of W's keys that S has no key for, as ".a.b[].c"; never when there is none. `Skip`: keys S may lack wherever
 * they are (see ListedOnly). Six levels deep at most: a tree of folders holds folders.
 */
type Unknown<S, W, Skip extends string = never, P extends string = "", D extends unknown[] = []> = [S] extends [never]
  ? never
  : D["length"] extends 6
    ? never
    : [W] extends [readonly (infer WI)[]]
      ? [S] extends [readonly (infer SI)[]] ? Unknown<NonNullable<SI>, NonNullable<WI>, Skip, `${P}[]`, [...D, 0]> : never
      : [W] extends [object]
        ? [S] extends [object]
          ? string extends KeysOf<W>
            ? never // a record by any key: nothing to hold its keys against
            : {
                [K in KeysOf<W> & string]-?: K extends KeysOf<S>
                  ? Unknown<NonNullable<At<S, K>>, NonNullable<At<W, K>>, Skip, `${P}.${K}`, [...D, 0]>
                  : K extends Skip ? never : `${P}.${K}`;
              }[KeysOf<W> & string]
          : never // the server's is untyped there (unknown, JSON read back): the web's is the only word on it
        : never;

/** The top-level keys of W the server's S sends as a type that does not fit, or does not send while W needs them. */
type Misfits<S, W> = { [K in KeysOf<W>]-?: K extends KeysOf<S> ? ([At<S, K>] extends [At<W, K>] ? never : K) : undefined extends At<W, K> ? never : K }[KeysOf<W>];
type Said<T> = [T] extends [never] ? "(a member of a union)" : T;
/**
 * True when the server's answer `S` and the web's shape `W` agree (see above); else what is wrong, said in the error.
 * `Skip`: keys the web reads from another answer into the same shape.
 */
type Agree<S, W, Skip extends string = never> = 0 extends 1 & (S | W)
  ? { anyOnOneSide: true } // an answer typed as any fits everything: it would check nothing
  : [S] extends [W]
  ? [Unknown<S, W, ListedOnly | Skip>] extends [never] ? true : { keysTheServerDoesNotHave: Unknown<S, W, ListedOnly | Skip> }
  : { doesNotFit: Said<Misfits<S, W>> };
const agree = <S, W, Skip extends string = never>() => expectTypeOf<Agree<S, W, Skip>>();

/**
 * A request body the web sends (`W`) held against what the server's schema takes (`S`, its z.input), both ways: the web's
 * must fit the schema; every key it sends, nested ones included, must be one the schema has (a strict schema refuses any
 * other, and a loose one drops it unread); and every key the schema takes must be one the web's shape has, so that a field
 * added on the server is not left out of the web's by mistake.
 */
type Takes<S, W> = 0 extends 1 & (S | W)
  ? { anyOnOneSide: true }
  : [W] extends [S]
    ? [Unknown<S, W>] extends [never]
      ? [Unknown<W, S>] extends [never] ? true : { keysTheWebDoesNotHave: Unknown<W, S> }
      : { keysTheServerDoesNotTake: Unknown<S, W> }
    : { doesNotFit: Said<Misfits<W, S>> };
const takes = <S, W>() => expectTypeOf<Takes<S, W>>();

/**
 * The keys of a library item the listings add (GET /api/assets): the web's one Asset has them as optional, and an item
 * read alone, or one inside another answer (a timeline's clip, an item's sources), goes without them.
 */
type ListedOnly = "clipOf" | "draftOf" | "shownName" | "family";

describe("the web's API types match what the server answers", () => {
  it("the library", () => {
    agree<ReturnType<typeof assetView>, Asset>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof assetDetail>>, AssetDetail>().toEqualTypeOf<true>();
    agree<NonNullable<Awaited<ReturnType<Timelines["clipOf"]>> extends Map<string, infer C> ? C : never>, ClipOf>().toEqualTypeOf<true>();
    // a draft of the tree has its counts from the drafts list (DraftLeaf)
    agree<Awaited<ReturnType<typeof projectsTree>>, ProjectsTree, "outputs" | "bytes" | "unused" | "models">().toEqualTypeOf<true>();
  });

  it("the queue, its history and the render times", () => {
    // the queue's view, with the GPU hunt's summary the queue adds to it
    agree<Awaited<ReturnType<Queue["status"]>>, QueueStatus>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof history>>, HistoryPage>().toEqualTypeOf<true>();
    agree<TimesSummary, WebTimes>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof list>>["items"][number], RenderItem>().toEqualTypeOf<true>();
  });

  it("timelines", () => {
    agree<Awaited<ReturnType<Timelines["view"]>>, Timeline>().toEqualTypeOf<true>();
    agree<Measure, WebMeasure>().toEqualTypeOf<true>();
  });

  it("drafts and the kit", () => {
    // the list's items add their cover, counts, model and models to the draft's own fields
    agree<DraftView, Omit<Draft, "cover" | "coverKind" | "outputs" | "bytes" | "unused" | "model" | "models">>().toEqualTypeOf<true>();
    // a kit item's definition is stored as JSON and sent back as read: the web's per-kind shapes are its only word on it
    agree<EntityView, Omit<Entity, "def" | "source">>().toEqualTypeOf<true>();
    agree<PresetFilesView, WebPresetFiles>().toEqualTypeOf<true>();
    // the drafts list: each draft's brief with its cover and counts
    agree<Awaited<ReturnType<typeof draftsList>>, { items: DraftBrief[]; unused: number }>().toEqualTypeOf<true>();
  });

  it("the library's live events", () => {
    agree<LibraryChange, WebLibraryChange>().toEqualTypeOf<true>();
    // and the other way: a change the server can say is one the page knows to read in place
    agree<WebLibraryChange, LibraryChange>().toEqualTypeOf<true>();
  });

  it("what the web sends", () => {
    takes<z.input<typeof clipPatch>, ClipPatch>().toEqualTypeOf<true>();
    takes<z.input<typeof timelinePatch>, TimelinePatch>().toEqualTypeOf<true>();
    takes<z.input<typeof saveBody>, DraftPatch>().toEqualTypeOf<true>();
    // any setting by key (the server parses the whole after merging), and the model in use the short way
    takes<Partial<z.input<typeof settingsSchema>> & { llm?: Partial<Omit<z.input<typeof llmSchema>, "id">> }, SettingsPatch>().toEqualTypeOf<true>();
  });

  it("settings, the command bar, downloads", () => {
    agree<ReturnType<typeof publicSettings>, WebSettings>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof commandIndex>>, CommandIndex>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof commandItems>>, { entries: WebEntry[] }>().toEqualTypeOf<true>();
    agree<CommandEntry, WebEntry>().toEqualTypeOf<true>();
    agree<CommandEstimate, WebEstimate>().toEqualTypeOf<true>();
    agree<PromptHistoryItem, WebPromptItem>().toEqualTypeOf<true>();
    agree<DownloadView, Download>().toEqualTypeOf<true>();
  });

  it("Model sets, and a deploy's files", () => {
    agree<ModelSetView, ModelSet>().toEqualTypeOf<true>();
    agree<SetFileView, SetFile>().toEqualTypeOf<true>();
    agree<DeployModelsView, DeployModels>().toEqualTypeOf<true>();
  });

  it("Afflatus's own updates", () => {
    agree<UpdatesView, WebUpdates>().toEqualTypeOf<true>();
  });
});
