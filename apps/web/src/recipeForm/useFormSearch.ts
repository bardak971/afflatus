import { useState } from "react";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { fileLabel } from "../format";

/**
 * The search over a form's settings: what is typed, and, for a setting another setting hides, the words that
 * say what shows it. A form is drawn afresh for each recipe (its key), so the search starts empty with it.
 */
export function useFormSearch(recipe: RecipeInfo) {
  const [query, setQuery] = useState("");
  const labelOf = (id: string) => recipe.inputs.find((i) => i.id === id)?.label ?? id;
  const revealedBy = (i: InputSpec): string => {
    const w = i.showWhen;
    if (!w) return "";
    if (typeof w === "string") return `shown when ${labelOf(w)} is set`;
    return `shown when ${labelOf(w.input)} is ${w.in.map((v) => (v === true ? "on" : v === false ? "off" : fileLabel(String(v)))).join(" or ")}`;
  };
  return { query, setQuery, q: query.trim(), revealedBy };
}
