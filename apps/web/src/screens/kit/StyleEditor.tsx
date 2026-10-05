import type { StyleDef } from "../../api";
import { useRecipes, useSetup } from "../../data";
import { Field } from "../../fields";
import { AutoText, SectionTitle } from "../../ui";
import { field, takes } from "./shared";

export function StyleEditor({ def, onChange }: { def: StyleDef; onChange(def: StyleDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const families = recipes.data?.families ?? [];
  const lorasOf = (family: string) => setup.data?.recipes.find((s) => recipes.data?.recipes.find((r) => r.id === s.id)?.family === family && s.options.loras)?.options.loras ?? [];
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Per model</SectionTitle>
      <span className="text-ink-2">A style is LoRAs and prompt text. Set it up for the models you use it with; for the others it adds nothing.</span>
      {families.map((f) => {
        const can = takes(f, recipes.data?.recipes ?? []);
        const m = def.models[f.id] ?? { loras: [], words: "" };
        const set = (patch: Partial<typeof m>) => onChange({ ...def, models: { ...def.models, [f.id]: { ...m, ...patch } } });
        return (
          <div key={f.id} className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
            <span className="font-semibold">{f.name}</span>
            {can.lora && <Field spec={{ id: "loras", type: "loras", label: "LoRAs", max: 4 }} value={m.loras} options={lorasOf(f.id)} family={f} onChange={(loras) => set({ loras: loras as StyleDef["models"][string]["loras"] })} />}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Prompt text {can.tags ? "(tags)" : "(natural language)"}</span>
              <AutoText rows={1} value={m.words} placeholder={can.tags ? "film grain, warm light" : "Shot on film, in warm evening light."} onChange={(e) => set({ words: e.target.value })} className={field} />
            </label>
          </div>
        );
      })}
    </div>
  );
}
