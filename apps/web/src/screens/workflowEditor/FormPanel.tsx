import { useState } from "react";
import { placeablesFor, suggestSections } from "@afflatus/workflows";
import { ask } from "../../Confirm";
import { useRecipes } from "../../data";
import { Form } from "../../RecipeForm";
import { cx, ErrorNote, Help, SectionTitle } from "../../ui";
import { FormSections } from "../FormSections";
import { SwitchDialog } from "../SwitchDialog";
import { Step, text } from "./parts";
import type { Mapping } from "./useMapping";

/** Words for the kinds of input the sections tray shows. */
const KIND_WORD: Record<string, string> = { prompt: "text", number: "number", toggle: "switch", choice: "choice", seed: "seed", size: "size", loras: "LoRAs", image: "picture", clip: "clip", references: "pictures", audio: "sound", model: "model file" };

/** Step 3: the form's name and model, its sections, and the form itself as Create will show it. */
export function FormPanel({ m, saveError }: { m: Mapping; saveError: Error | null }) {
  const { b, set, graph, preview, title, setTitle, model, setModel, switchFor, setSwitchFor } = m;
  // a built-in family and the workflows made for the same model share its name: offered once
  const familyNames = [...new Set((useRecipes().data?.families ?? []).map((f) => f.name))];
  const inputs = preview.recipe?.inputs ?? [];
  // everything the form will hold can be placed in a section, the main prompt apart (it leads the form, with its helpers)
  const placeable = inputs
    .filter((i) => !(i.type === "prompt" && i.id === "prompt") && !b.toggles.some((t) => t.made && t.id === i.id))
    .map((i) => ({ id: i.id, label: i.label, kind: KIND_WORD[i.type] ?? i.type }));
  const [suggestedWhy, setSuggestedWhy] = useState<string[] | null>(null);
  const frames = m.wiring?.frames ?? [];
  const suggest = async () => {
    const has = (b.sections ?? []).some((s) => s.items.length);
    if (has && !(await ask({ title: "Replace the sections?", text: "The sections you made are replaced by a proposal from the author's frames. Switches made here go with them.", yes: "Replace" }))) return;
    const made = suggestSections(graph, m.wiring, b.result.node, placeablesFor(b, inputs), frames, b.toggles);
    set({ sections: made.sections, toggles: [...b.toggles.filter((t) => !t.made), ...made.toggles] });
    setSuggestedWhy(made.why);
  };
  return (
    <section className="flex min-h-0 flex-col gap-3.5 overflow-y-auto bg-panel p-5">
      <Step n={3} title="The form" hint="Name it, say which model it is for, and arrange its sections. Below, the form as Create will show it." />
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wf-title" className="text-xs font-semibold">Name</label>
          <input id="wf-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Portrait, two passes" className={text} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5">
            <label htmlFor="wf-model" className="text-xs font-semibold">Model</label>
            <Help title="Model" text="Which model it runs, as the families call them: workflows of one model share its LoRAs and saved settings." />
          </span>
          <input id="wf-model" list="wf-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="SDXL, Wan 2.2, MiniMax H3…" className={cx(text, !model.trim() && "border-warn/60")} />
          <datalist id="wf-models">{familyNames.map((n) => <option key={n} value={n} />)}</datalist>
        </div>
      </div>
      {!model.trim() && <span className="-mt-2 text-xs text-warn-ink">Model: needed to save</span>}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Sections</SectionTitle>
          <Help title="Sections" text="Chapters of the form, in your order; a section can carry a switch. The form is the prompt, your sections in order, and Advanced with everything else. Drag a setting into a section, or under a switch; drag the Prompt and Advanced cards to move those." />
        </div>
        <FormSections
          sections={b.sections ?? []}
          onChange={m.setSections}
          items={placeable}
          toggles={b.toggles}
          onMakeSwitch={(section, toggle) => setSwitchFor({ section, toggle })}
          onDropSwitch={m.dropSwitch}
          onSwitchDefault={(id, on) => m.changeSwitch(id, { default: on })}
          cuts={(t) => t.effects.some((e) => e.nodes.includes(b.result.node))}
          onSuggest={() => void suggest()}
          canSuggest={frames.length > 0}
        />
        {suggestedWhy && (
          <div className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2 text-xs text-ink-2">
            <span className="font-semibold text-ink">What the proposal did, frame by frame. Edit as you like.</span>
            {suggestedWhy.map((w) => <span key={w}>{w}</span>)}
          </div>
        )}
      </div>
      {switchFor && (
        <SwitchDialog
          section={switchFor.section}
          existing={switchFor.toggle ? b.toggles.find((t) => t.id === switchFor.toggle) : undefined}
          frames={frames}
          nodes={m.nodeList}
          resultNode={b.result.node}
          onClose={() => setSwitchFor(null)}
          onSave={(t) => m.saveSwitch(switchFor.section, t)}
          onRemove={() => { if (switchFor.toggle) m.dropSwitch(switchFor.section, switchFor.toggle); setSwitchFor(null); }}
        />
      )}

      {/* the form itself, as Create will draw it: the same chapters, strip and folds as the built-ins */}
      <div className="flex items-center gap-2">
        <SectionTitle>Preview</SectionTitle>
        <Help title="Preview" text="The form as Create shows it, built the same way." />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-ground p-3.5">
        {preview.described && inputs.length > 0 && (
          <Form
            recipe={preview.described}
            status={undefined}
            keepEmpty
            stored={m.values}
            onChange={(id, v) => m.setValues((old) => ({ ...old, [id]: v }))}
            onClear={(ids) => m.setValues((old) => Object.fromEntries(Object.entries(old).filter(([k]) => !ids.includes(k))))}
          />
        )}
        {preview.described && !inputs.length && <span className="text-ink-2">No inputs: it would always generate the same output.</span>}
        {preview.error !== null && <ErrorNote>This mapping cannot be previewed: {preview.error}</ErrorNote>}
      </div>

      {preview.recipe?.traits && (
        <div className="flex flex-col gap-1 text-xs text-ink-2">
          <span className="font-semibold text-ink">In a timeline, a clip generated with it</span>
          <span>{preview.recipe.traits.startFrame ? "takes a first frame, and can extend the previous clip from its last frame" : "takes no first frame"}</span>
          <span>{preview.recipe.traits.endFrame ? "takes a last frame" : "takes no last frame"}</span>
          <span>{preview.recipe.traits.sound ? "has audio" : "has no audio"}</span>
        </div>
      )}

      {saveError && <ErrorNote>{saveError.message}</ErrorNote>}
    </section>
  );
}
