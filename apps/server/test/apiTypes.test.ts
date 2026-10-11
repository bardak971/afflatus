import { describe, expectTypeOf, it } from "vitest";
// the web's shapes of the server's answers (apps/web/src/api/types), as the page reads them
import type { Asset, AssetDetail, ClipOf, ProjectsTree } from "../../web/src/api/types/library";
import type { HistoryPage, QueueStatus, RenderItem, TimesSummary as WebTimes } from "../../web/src/api/types/queue";
import type { Measure as WebMeasure, Timeline } from "../../web/src/api/types/timeline";
import type { Draft, Entity, PresetFilesView as WebPresetFiles } from "../../web/src/api/types/designer";
import type { Settings as WebSettings } from "../../web/src/api/types/settings";
import type { CommandEntry as WebEntry, CommandEstimate as WebEstimate, CommandIndex, PromptHistoryItem as WebPromptItem } from "../../web/src/api/types/bar";
import type { Download } from "../../web/src/api/types/models";
// the server's own: what its routes return
import type { assetDetail } from "../src/assets-api";
import type { CommandEntry, CommandEstimate, commandIndex, commandItems } from "../src/commandIndex";
import type { Measure } from "../src/cut";
import type { DownloadView } from "../src/downloads";
import type { DraftView } from "../src/drafts";
import type { EntityView } from "../src/entities";
import type { assetView } from "../src/media";
import type { PresetFilesView } from "../src/presetFiles";
import type { projectsTree } from "../src/projects";
import type { PromptHistoryItem } from "../src/promptHistory";
import type { history, status } from "../src/queueView";
import type { list, TimesSummary } from "../src/rendersRead";
import type { publicSettings } from "../src/settings";
import type { Timelines } from "../src/timelines";

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
    agree<Awaited<ReturnType<typeof status>>, QueueStatus>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof history>>, HistoryPage>().toEqualTypeOf<true>();
    agree<TimesSummary, WebTimes>().toEqualTypeOf<true>();
    agree<Awaited<ReturnType<typeof list>>["items"][number], RenderItem>().toEqualTypeOf<true>();
  });

  it("timelines", () => {
    agree<Awaited<ReturnType<Timelines["view"]>>, Timeline>().toEqualTypeOf<true>();
    agree<Measure, WebMeasure>().toEqualTypeOf<true>();
  });

  it("drafts and the kit", () => {
    // the list's items add their cover, counts and models to the draft's own fields
    agree<DraftView, Omit<Draft, "cover" | "coverKind" | "outputs" | "bytes" | "unused" | "models">>().toEqualTypeOf<true>();
    // a kit item's definition is stored as JSON and sent back as read: the web's per-kind shapes are its only word on it
    agree<EntityView, Omit<Entity, "def" | "source">>().toEqualTypeOf<true>();
    agree<PresetFilesView, WebPresetFiles>().toEqualTypeOf<true>();
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
});
