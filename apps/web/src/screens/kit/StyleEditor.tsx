import type { StyleDef } from "../../api";
import { useRecipes, useSetup } from "../../data";
import { Field } from "../../fields";
import { Block, Card, Row } from "../../Rows";
import { AutoText } from "../../ui";
import { field, takes } from "./shared";

/** A style per model family: one row of prompt text each, its LoRAs under it where the model takes them. */
export function StyleEditor({ def, onChange }: { def: StyleDef; onChange(def: StyleDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const families = recipes.data?.families ?? [];
  const lorasOf = (family: string) => setup.data?.recipes.find((s) => recipes.data?.recipes.find((r) => r.id === s.id)?.family === family && s.options.loras)?.options.loras ?? [];
  return (
    <Card dense title="Per model" help="A style is LoRAs and prompt text. Set it up for the models you use it with; for the others it adds nothing. Each model gets its prompt text as it reads it: tags or natural language.">
      {families.map((f) => {
        const can = takes(f, recipes.data?.recipes ?? []);
        const m = def.models[f.id] ?? { loras: [], words: "" };
        const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
        return (
          <div key={f.id}>
            <Row label={f.name} sub={can.tags ? "tags" : "natural language"}>
              <AutoText aria-label={`Prompt text of the style for ${f.name}`} rows={1} value={m.words} placeholder={can.tags ? "film grain, warm light" : "Shot on film, in warm evening light."} onChange={(e) => set({ words: e.target.value })} className={field} />
            </Row>
            {can.lora && (
              // the LoRAs list says its own name and count: a block under the row (no line between), aligned with the controls
              <Block className="pt-0! pl-[180px]!">
                <Field spec={{ id: "loras", type: "loras", label: "LoRAs", max: 4 }} value={m.loras} options={lorasOf(f.id)} family={f} onChange={(loras) => set({ loras: loras as StyleDef["models"][string]["loras"] })} />
              </Block>
            )}
          </div>
        );
      })}
    </Card>
  );
}
