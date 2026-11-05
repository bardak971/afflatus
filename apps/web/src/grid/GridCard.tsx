import { axisValues, GRID_ASK_USD, GRID_AXES, gridFields, plural, splitValues, type GridAxis, type GridField, type GridSetup } from "@afflatus/core";
import type { RecipeInfo, RecipeStatus } from "../api";
import { aboutMs, usd } from "../format";
import { Select, type Option } from "../Select";
import { cx, fieldClass, Help } from "../ui";
import { gridOptions, type GridPlan } from "./gridPlan";

/** What each kind of axis takes, said in its box while it is empty: A1111's forms. */
const HINT: Record<GridField["kind"], string> = {
  number: "20, 30, 40 · 1-5 · 1-10 (+2) · 0-1 [5]",
  lora: "0.4, 0.8, 1.2 · 0-1 [5]",
  seed: "1234, 5678 · 1-4",
  sr: "first value, then each that replaces it",
  choice: "pick below, or type them",
  model: "pick below, or type part of the names",
  toggle: "off, on",
  size: "Square, 832x1216",
};

const NONE = "";

/** The axes as kept, always three places (X, Y, Z): a place with no setting is an axis not used. */
const placesOf = (setup: GridSetup | null | undefined): GridAxis[] => GRID_AXES.map((_, i) => setup?.axes[i] ?? { field: NONE, values: "" });

/**
 * The Grid card of the form (card #21, the mock's variant A): X, Y and Z, each a setting from a searchable picker (Prompt
 * S/R, the models, a LoRA's weight, any number, choice or switch, the seed) and its values typed as A1111 types them, or
 * picked from the list for a choice; then the count and what it will take, said before anything is queued, with the money
 * on a rented pod. Queue grid sits beside Render (GenerateBar).
 */
export function GridCard({ recipe, whole, status, setup, plan, onChange }: {
  recipe: RecipeInfo;
  whole: Record<string, unknown>;
  status: RecipeStatus | undefined;
  setup: GridSetup | null | undefined;
  plan: GridPlan;
  onChange(setup: GridSetup | null): void;
}) {
  const fields = gridFields(recipe.inputs, whole);
  const places = placesOf(setup);
  const set = (i: number, axis: GridAxis) => {
    const next = places.map((a, k) => (k === i ? axis : a));
    // the places after the last one used are not kept: an empty set-up is none
    while (next.length && !next[next.length - 1]!.field) next.pop();
    onChange(next.length ? { axes: next } : null);
  };
  const options: Option[] = [{ value: NONE, label: "None", note: "this axis is not used" }, ...fields.map((f) => ({ value: f.id, label: f.label, group: f.group, note: f.kind === "sr" ? "search / replace" : undefined }))];
  return (
    <div className="flex flex-col gap-2">
      {places.map((axis, i) => {
        const field = fields.find((f) => f.id === axis.field);
        const error = plan.error?.axis === i ? plan.error.text : null;
        // how many values the axis makes, ranges read out ("4-8 (+2)" is three)
        const read = field && axis.values.trim() ? axisValues(recipe.inputs, whole, axis, gridOptions(status)) : null;
        const n = read && "axis" in read ? read.axis.values.length : 0;
        const choices = field && (field.kind === "choice" || field.kind === "model") ? choicesOf(recipe, status, field) : [];
        return (
          <div key={GRID_AXES[i]} data-grid-axis={GRID_AXES[i]} className="grid grid-cols-[22px_minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-control border border-line bg-raised px-2.5 py-2">
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-line-strong text-xs font-extrabold text-ink">{GRID_AXES[i]}</span>
            <Select
              size="sm"
              label={`${GRID_AXES[i]} axis: the setting`}
              searchHint="Search any field"
              value={field ? field.id : NONE}
              options={options}
              placeholder="None"
              onChange={(id) => set(i, { field: id, values: id === axis.field ? axis.values : startValues(fields.find((f) => f.id === id), whole) })}
            />
            <input
              aria-label={`${GRID_AXES[i]} axis: the values`}
              aria-invalid={Boolean(error)}
              disabled={!field}
              value={axis.values}
              placeholder={field ? HINT[field.kind] : "pick a setting first"}
              onChange={(e) => set(i, { ...axis, values: e.target.value })}
              className={cx(fieldClass, "h-8 min-w-0 font-mono text-xs disabled:opacity-50")}
            />
            {field && (
              <span className={cx("col-start-3 flex min-w-0 flex-wrap items-center gap-1.5 text-meta", error ? "text-warn-ink" : "text-ink-3")}>
                {error ?? (field.kind === "sr" && n ? `${plural(n, "value")} · “${splitValues(axis.values)[0]}” is found in the prompt and replaced` : plural(n, "value"))}
                {choices.length > 0 && (
                  <Select
                    size="sm"
                    dashed
                    label={`Add a value to the ${GRID_AXES[i]} axis`}
                    value=""
                    placeholder="+ add"
                    options={choices.filter((c) => !splitValues(axis.values).includes(c.value))}
                    onChange={(v) => set(i, { ...axis, values: [...splitValues(axis.values), v].map(quoted).join(", ") })}
                    className="w-auto!"
                  />
                )}
              </span>
            )}
          </div>
        );
      })}
      <GridCost plan={plan} />
    </div>
  );
}

/** The count and what it will take, always said before queuing: the time from your own renders, and on a pod the money. */
export function GridCost({ plan }: { plan: GridPlan }) {
  if (!plan.count) return <span className="px-1 text-xs text-ink-3">Pick a setting and type its values: every combination is rendered and laid out as one board on the Stage.</span>;
  return (
    <div data-grid-cost className="flex flex-col gap-0.5 rounded-control border border-line bg-raised px-3 py-2 text-sm">
      <span><b className="text-ink-strong">{plan.said}</b>{plan.ms !== null && <> · {aboutMs(plan.ms)}</>}</span>
      {plan.pod && (
        <span className="flex items-center gap-1 text-xs text-ink-2">
          On your pod: {plan.pod.ms !== null ? aboutMs(plan.pod.ms) : "time not known yet"} · {plan.pod.usd !== null ? `about ${usd(plan.pod.usd, true)}` : "cost not known yet"}
          <Help text={`From your own render times for this model, each cell at its own steps and size (render_stats), on the pod's hourly rate. Asked before queuing above $${GRID_ASK_USD}, near a spending cap, or when it cannot be told.`} />
        </span>
      )}
    </div>
  );
}

/** A value with a comma in it, quoted as A1111 reads it. */
const quoted = (v: string) => (v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v);

/** What an axis starts with when its setting is picked: a switch both ways, a choice its value now; else nothing to undo. */
function startValues(field: GridField | undefined, whole: Record<string, unknown>): string {
  if (!field) return "";
  if (field.kind === "toggle") return "off, on";
  if ((field.kind === "choice" || field.kind === "model") && typeof whole[field.input] === "string") return quoted(String(whole[field.input]));
  return "";
}

/** The options of a choice or a model field, as the form lists them: the machine's lists, else the recipe's own. */
function choicesOf(recipe: RecipeInfo, status: RecipeStatus | undefined, field: GridField): Option[] {
  const spec = recipe.inputs.find((i) => i.id === field.input);
  const own = spec?.type === "choice" && Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options] : [];
  const list = status?.options[field.input]?.length ? status.options[field.input]! : own;
  const labels = spec?.type === "choice" ? spec.labels : undefined;
  return list.map((v) => ({ value: v, label: labels?.[v] ?? v }));
}
