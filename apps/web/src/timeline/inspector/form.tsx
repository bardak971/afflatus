import type { ComponentProps } from "react";
import { ChevronDown, Wand2 } from "lucide-react";
import { joinWay, removedSaid, secondsInput } from "@afflatus/core";
import { thumbUrl, type Clip, type RecipeInfo, type Take, type Timeline } from "../../api";
import { useEntities, useRecipes } from "../../data";
import { WritingHelp } from "../../WritingHelp";
import { appendTo } from "../../promptText";
import { LookBar, lookWords } from "../../LookBar";
import { recipeLabel } from "../../format";
import { Form, mainTextOf } from "../../RecipeForm";
import { timelineKey } from "../../draftMachine";
import { usePickedMachine } from "../../GenerateOn";
import { CardPrompt } from "../../recipeForm/Part";
import { CastPictures } from "../../castPictures";
import { useInputEdits } from "../../hooks";
import { Select } from "../../Select";
import { AutoText, Button, cx, fieldClass, NumberBox, Segmented, Spinner } from "../../ui";
import { fileVersion, type ShownPatch } from "../model";
import { inRunSaid, playsOver, recordingInput, runFrom } from "../track/RecordingBand";
import { JOIN_WORDS, OTHER_MODELS_SAID, recordingFormOptions } from "../recordingForms";
import type { OffHere } from "../../RecipeForm";

type FormProps = ComponentProps<typeof Form>;

/**
 * A clip's model and its form, in the Inspector: only the choice of a model while nothing renders it; a clip that joins its
 * neighbours and is not rendered yet gets the Join view first (what happens between the two), the whole form folded under it.
 */
export function ClipForm({ timeline, clip, index, recipes, recipe, form, status, stored, whole, before, after, take, opens, ends, carries, lead, frameExtra, chapterExtra, writing, writeError, onRecipe, onInputs, onPatch, onDesigner, onWriteBetween }: {
  timeline: Timeline;
  clip: Clip;
  index: number;
  /** The video models a clip can be made with. */
  recipes: RecipeInfo[];
  recipe: RecipeInfo | undefined;
  /** The recipe without what the timeline fills in itself (the clips it joins onto, its pinned pictures). */
  form: RecipeInfo | undefined;
  status: FormProps["status"];
  stored: Record<string, unknown>;
  whole: Record<string, unknown> | null;
  before: Clip | undefined;
  after: Clip | undefined;
  take: Take | null;
  /** Its pinned first and last picture, and whether it carries on from the clip before. */
  opens: string | null;
  ends: string | null;
  carries: boolean;
  lead: FormProps["lead"];
  frameExtra: FormProps["frameExtra"];
  chapterExtra?: FormProps["chapterExtra"];
  writing?: boolean;
  writeError?: string | null;
  onRecipe(id: string): void;
  onInputs(next: Record<string, unknown>): void;
  onPatch(patch: ShownPatch): void;
  onDesigner(): void;
  onWriteBetween?(): void;
}) {
  const all = useRecipes();
  const entities = useEntities();
  const edit = useInputEdits(stored, onInputs);
  // inside a run of its recording (a song cut into clips end to end), Speech starts at does not apply: greyed, why in its "?"
  const runBefore = runFrom(timeline.clips, recipes, clip, { ...clip.inputs, ...stored });
  // under a recording (card #72): only the forms a clip under one takes are offered; on one it plays over (Video with
  // audio) its part sets its length, as a Lip sync clip's does, its Duration greyed with the part's
  const recording = recordingInput(recipe);
  const under = Boolean(recording && clip.inputs[recording.id]);
  const over = playsOver(clip, recipes);
  const duration = secondsInput(form?.inputs ?? []);
  const partS = recording ? Number(clip.inputs[recording.seconds] ?? 0) : 0;
  const off: Record<string, OffHere> | undefined = runBefore || (over && duration)
    ? {
        ...(runBefore ? Object.fromEntries((recording?.lead ?? []).map((id) => [id, inRunSaid(runBefore)])) : {}),
        ...(over && duration ? { [duration.id]: { why: "Set by its part of the recording: the clip lasts as long as its part, as a Lip sync clip does, so that the next part starts where its picture ends.", value: `${partS.toFixed(1)} s, its part` } } : {}),
      }
    : undefined;
  // the machine picked for the timeline's renders: the form's node pack notes speak for it
  const pickedOn = usePickedMachine(timelineKey(timeline.id));
  // how each model would meet the clip before, said beside it before it is picked (the join rule, joinWay): a still or no clip
  // before says nothing. The forms made window by window come last, under where they are made from
  const prior = index > 0 && before?.kind === "video" && before.recipe ? all.data?.recipes.find((r) => r.id === before.recipe) : undefined;
  const ordered = [...recipes.filter((r) => !r.traits?.windows), ...recipes.filter((r) => r.traits?.windows)];
  const picker = under ? (
    // under a recording: what the recording does on each form, how it meets the clip before; leaving it is Remove
    <Select
      label="Model"
      value={recipe?.id ?? ""}
      onChange={onRecipe}
      options={recordingFormOptions(recipes, all.data?.families, prior).map((o) => ({ ...o, group: "Under the recording" }))}
      footer={() => <div className="border-t border-line px-3 py-2 text-xs text-ink-3">{OTHER_MODELS_SAID}</div>}
    />
  ) : (
    <Select
      label="Model"
      value={recipe?.id ?? ""}
      onChange={onRecipe}
      placeholder={recipes.length ? "Choose a model for this clip" : "No video model yet: import a workflow"}
      options={ordered.map((r) => ({
        value: r.id,
        label: recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title),
        detail: r.summary,
        ...(r.traits?.windows ? { group: "From a source", note: "a window of the source" } : prior ? { note: `${JOIN_WORDS[joinWay(prior, r)]} after clip ${index}` } : {}),
      }))}
    />
  );
  // nothing renders it yet: only the choice of what does
  // a clip made with a model taken out of Afflatus says so: its take plays on, a new one needs another model
  if (!form || !recipe) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold">Model</div>
        {picker}
        {removedSaid(clip.recipe) && <span className="text-xs text-warn-ink">Made with {removedSaid(clip.recipe)}: {take ? "its take plays on; a new take" : "it"} needs another model.</span>}
      </div>
    );
  }
  // on a clip the recording plays over: what the person does said in positive words (#79: "listens, mouth closed" kept the
  // mouth still; H3 reads a negation as the thing), and Music left empty (naming the song moved the lips)
  const shownForm: RecipeInfo = over
    ? {
        ...form,
        inputs: form.inputs.map((i) =>
          i.id === "description" && i.type === "prompt" ? { ...i, placeholder: "She listens, eyes closed, her mouth closed, swaying slowly to the music." }
          : i.id === "music" && i.type === "prompt" ? { ...i, note: "Under a recording, leave it empty: the recording is the clip's sound, and naming a song moves the lips." }
          : i),
      }
    : form;
  const main = mainTextOf(form);
  const written = main ? String(stored[main.id] ?? "") : "";
  const cast = clip.look === null ? (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold">Cast and look</div>
      <div className="flex flex-wrap items-center gap-2">
        <span>{lookWords(timeline.look, entities.data?.items ?? []) || "Nobody yet"}</span>
        <span className="text-xs text-ink-2">from the timeline</span>
        <Button size="sm" onClick={() => onPatch({ look: timeline.look ?? { cast: [], style: null } })}>Change for this clip</Button>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-1.5">
      <LookBar title="Cast and look · this clip only" look={clip.look} onChange={(look) => onPatch({ look })} recipe={recipe} input={stored} />
      <span><Button size="sm" onClick={() => onPatch({ look: null })}>Use the timeline's again</Button></span>
    </div>
  );
  // a clip that joins its neighbours and is not rendered yet: what matters for the join first, the whole form folded under it
  const nextJoined = Boolean(after && after.joined === "continue" && after.take);
  // the Join view is for a clip put between two others: something to arrive at, not merely a clip that extends the one before.
  // A window of a source follows its driving video: nothing is written for what happens between, it lands nowhere
  const joins = !take && !recipe.traits?.windows && (nextJoined || Boolean(ends));
  const leftFrame = opens ? thumbUrl(opens) : carries && before ? (before.kind === "still" && before.still ? thumbUrl(before.still.id) : before.take ? `/api/assets/${before.take.asset.id}/peek?at=${Math.max(0, Math.round(before.take.endMs - 20))}&h=160&v=${fileVersion(before.take.asset)}` : null) : null;
  const rightFrame = ends ? thumbUrl(ends) : nextJoined && after?.take ? `/api/assets/${after.take.asset.id}/peek?at=${Math.round(after.take.startMs)}&h=160&v=${fileVersion(after.take.asset)}` : null;
  const startsHow = carries ? `Extends clip ${index}: its motion carries in` : opens ? `Opens on a picture` : "Starts on its own";
  // its own pinned last frame wins over landing on the clip after (the server skips the landing then)
  const endsHow = ends ? "ends on a picture" : nextJoined ? `ends where clip ${index + 2} begins` : "ends free";
  // (a clip the recording plays over lasts as long as its part: no Duration to set beside the join)
  const seconds = over ? undefined : duration;
  // the input the form's next clip names for how many of its frames are landed on (H3's Landing), not an id of H3's own
  const nextClip = recipe.inputs.find((i) => i.type === "clip" && i.role === "next");
  const landing = nextClip?.type === "clip" && nextClip.framesFrom ? recipe.inputs.find((i) => i.id === nextClip.framesFrom && i.type === "choice") : undefined;
  const landingOptions = landing && landing.type === "choice" && Array.isArray(landing.options) ? landing.options : [];
  // three counts read as a tight, a normal and a long landing, whatever the model's counts are
  const landingWord = (o: string, k: number) => (landingOptions.length === 3 ? `${["Tight", "Normal", "Long"][k]} · ${o}` : o);
  // the prompt as a card of its own, as in the Studio: the same cards, spaced alike
  const formElement = (
      <CastPictures recipe={form} input={whole ?? stored} look={clip.look ?? timeline.look}>
      <CardPrompt.Provider value>
      <Form
        key={`${clip.id}:${form.id}`}
        recipe={shownForm}
        machine={pickedOn?.id}
        given={carries ? { previous: true } : undefined}
        status={status}
        stored={stored}
        onChange={edit}
        onClear={(inputs) => onInputs(Object.fromEntries(Object.entries(stored).filter(([k]) => !inputs.includes(k))))}
        made={picker}
        madeSummary={recipeLabel(all.data?.families.find((f) => f.id === recipe.family)?.name, recipe.title)}
        look={cast}
        lookSummary={lookWords(clip.look ?? timeline.look, entities.data?.items ?? []) + (clip.look === null && timeline.look ? " (from the timeline)" : "")}
        lead={lead}
        off={off}
        frameExtra={frameExtra}
        chapterExtra={chapterExtra}
        helpers={
          <WritingHelp
            recipe={form}
            text={written}
            // a clip that follows the timeline's cast gets a look of its own with the first snippet ticked: the timeline's, plus it
            look={clip.look ?? timeline.look}
            onLook={(look) => onPatch({ look })}
            onDesigner={onDesigner}
            onInsert={(snippet) => main?.type === "prompt" && onInputs({ ...stored, [main.id]: appendTo(written, snippet, main.style) })}
          />
        }
      />
      </CardPrompt.Provider>
      </CastPictures>
  );
  if (!joins) return <div className="flex flex-col gap-2.5">{formElement}</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-wash/30 p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{leftFrame ? <img src={leftFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-micro text-ink-3">—</span>}</div>
          <div className="flex min-w-0 grow flex-col gap-0.5 text-xs">
            <span className="font-semibold">Join</span>
            <span className="text-ink-2">{startsHow} · {endsHow}.</span>
          </div>
          <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{rightFrame ? <img src={rightFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-micro text-ink-3">—</span>}</div>
        </div>
        {main && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">What happens <span className="font-normal text-ink-2">· between the two</span></span>
            <AutoText rows={3} value={written} disabled={writing} placeholder={main.type === "prompt" ? main.placeholder ?? "What happens in this stretch" : ""} onChange={(e) => onInputs({ ...stored, [main.id]: e.target.value })} className={cx(fieldClass, "w-full py-2 disabled:opacity-60")} />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {writing ? (
            <span className="flex items-center gap-1.5 text-ink-2"><Spinner />The designer is writing what happens between…</span>
          ) : (
            <>
              {onWriteBetween && (nextJoined || ends) && <Button size="sm" onClick={onWriteBetween} data-tip="The designer writes the stretch from how the clip before ends to how the clip after starts, in the clip's time."><Wand2 size={13} /> {written ? "Designer: write it again" : "Designer: write it"}</Button>}
              <Button size="sm" onClick={onDesigner}>Talk to the designer</Button>
            </>
          )}
          {writeError && <span className="text-warn-ink">{writeError}</span>}
        </div>
        {seconds && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">Duration</span>
            <NumberBox label="Duration" value={Number(stored[seconds.id] ?? seconds.default)} min={seconds.min} max={seconds.max} step={seconds.step} unit=" s" onCommit={(v) => onInputs({ ...stored, [seconds.id]: v })} />
          </div>
        )}
        {landing && nextJoined && landingOptions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-xs font-semibold">Landing <span className="font-normal text-ink-2">frames of clip {index + 2} it lands on</span></span>
            <Segmented label="Landing" value={String(stored[landing.id] ?? (landing.type === "choice" ? landing.default : ""))} onChange={(v) => onInputs({ ...stored, [landing.id]: v })} options={landingOptions.map((o, k) => ({ value: o, label: landingWord(String(o), k) }))} />
          </div>
        )}
      </div>
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink"><ChevronDown size={13} className="transition-transform group-open:rotate-180" /> All settings</summary>
        {/* the cards at the panel's full width, under the switch: not boxed a second time */}
        <div className="flex flex-col gap-2.5 pt-3">{formElement}</div>
      </details>
    </div>
  );
}
