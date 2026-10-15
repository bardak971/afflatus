import type { ComponentProps } from "react";
import { ChevronDown, Wand2 } from "lucide-react";
import { removedSaid, secondsInput } from "@afflatus/core";
import { thumbUrl, type Clip, type RecipeInfo, type Take, type Timeline } from "../../api";
import { useEntities, useRecipes } from "../../data";
import { WritingHelp } from "../../WritingHelp";
import { appendTo } from "../../promptText";
import { LookBar, lookWords } from "../../LookBar";
import { recipeLabel } from "../../format";
import { Form, mainTextOf } from "../../RecipeForm";
import { CardPrompt } from "../../recipeForm/Part";
import { CastPictures } from "../../castPictures";
import { Select } from "../../Select";
import { AutoText, Button, cx, fieldClass, NumberBox, Segmented } from "../../ui";
import { fileVersion, type ShownPatch } from "../model";

type FormProps = ComponentProps<typeof Form>;

/**
 * A clip's model and its form, in the Inspector: only the choice of a model while nothing renders it; a clip that joins its
 * neighbours and is not rendered yet gets the Join view first (what happens between the two), the whole form folded under it.
 */
export function ClipForm({ timeline, clip, index, recipes, recipe, form, status, stored, whole, before, after, take, opens, ends, carries, lead, frameExtra, writing, writeError, onRecipe, onInputs, onPatch, onDesigner, onWriteBetween }: {
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
  const picker = (
    <Select
      label="Model"
      value={recipe?.id ?? ""}
      onChange={onRecipe}
      placeholder={recipes.length ? "Choose a model for this clip" : "No video model yet: import a workflow"}
      options={recipes.map((r) => ({ value: r.id, label: recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title), detail: r.summary }))}
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
  const seconds = secondsInput(form.inputs);
  const landing = recipe.inputs.find((i) => i.id === "landing" && i.type === "choice");
  const landingOptions = landing && landing.type === "choice" && Array.isArray(landing.options) ? landing.options : [];
  // the prompt as a card of its own, as in the Studio: the same cards, spaced alike
  const formElement = (
      <CastPictures recipe={form} input={whole ?? stored} look={clip.look ?? timeline.look}>
      <CardPrompt.Provider value>
      <Form
        key={`${clip.id}:${form.id}`}
        recipe={form}
        given={carries ? { previous: true } : undefined}
        status={status}
        stored={stored}
        onChange={(input, value) => onInputs({ ...stored, [input]: value })}
        onClear={(inputs) => onInputs(Object.fromEntries(Object.entries(stored).filter(([k]) => !inputs.includes(k))))}
        made={picker}
        madeSummary={recipeLabel(all.data?.families.find((f) => f.id === recipe.family)?.name, recipe.title)}
        look={cast}
        lookSummary={lookWords(clip.look ?? timeline.look, entities.data?.items ?? []) + (clip.look === null && timeline.look ? " (from the timeline)" : "")}
        lead={lead}
        frameExtra={frameExtra}
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
          <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{leftFrame ? <img src={leftFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
          <div className="flex min-w-0 grow flex-col gap-0.5 text-xs">
            <span className="font-semibold">Join</span>
            <span className="text-ink-2">{startsHow} · {endsHow}.</span>
          </div>
          <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{rightFrame ? <img src={rightFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
        </div>
        {main && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">What happens <span className="font-normal text-ink-2">· between the two</span></span>
            <AutoText rows={3} value={written} disabled={writing} placeholder={main.type === "prompt" ? main.placeholder ?? "What happens in this stretch" : ""} onChange={(e) => onInputs({ ...stored, [main.id]: e.target.value })} className={cx(fieldClass, "w-full py-2 disabled:opacity-60")} />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {writing ? (
            <span className="animate-pulse text-ink-2">The designer is writing what happens between…</span>
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
            <Segmented label="Landing" value={String(stored.landing ?? (landing.type === "choice" ? landing.default : "22"))} onChange={(v) => onInputs({ ...stored, landing: v })} options={landingOptions.map((o) => ({ value: o, label: o === "5" ? "Tight · 5" : o === "22" ? "Normal · 22" : o === "39" ? "Long · 39" : o }))} />
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
